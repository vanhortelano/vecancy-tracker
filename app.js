/* =========================================================================
   BOARDING HOUSE VACANCY TRACKER — main app logic
   Data lives in Firebase Firestore (collections: rooms, prospects, layout)
  Auth is email/password via Firebase Auth.
   ========================================================================= */

const DAY_MS = 86400000;
const GENDERS = ["Male","Female","Mixed"];
const CAP_PRESETS = [2,4,5,6,8];

let db = null;
let auth = null;
let currentUser = null;
let rooms = [];          // [{id, room, capacity, gender, type, x, y, beds:[{slot,tenant,start,end,reservedFor}]}]
let prospects = [];      // [{id, name, gender, checkIn, checkOut, notes, reservedBed:{roomId,slot}}]
let unsubRooms = null, unsubProspects = null;
let activeTab = "dashboard";
let calOffset = 0; // months from current month, unbounded either direction
let editingRoomId = null;

/* ---------------------------- boot ---------------------------- */

function boot(){
  if (document.body.dataset.mode === "preview"){
    if (window.__previewBooted) return;
    window.__previewBooted = true;
    currentUser = {displayName:"Preview", email:"preview@local"};
    rooms = (window.SEED_ROOMS || []).map((room, index)=>({
      id: "preview-" + index,
      ...room,
      type: "Room",
      x: 20 + (index % 6) * 150,
      y: 20 + Math.floor(index / 6) * 130,
      beds: room.beds.map(bed=>({...bed, reservedFor:null}))
    }));
    prospects = [];
    startClock();
    wireStaticUI();
    showApp();
    return;
  }
  const cfg = window.FIREBASE_CONFIG;
  const notConfigured = !cfg || cfg.apiKey === "YOUR_API_KEY";
  if (notConfigured){
    document.getElementById("configWarning").style.display = "block";
    document.getElementById("signInBtn").disabled = true;
    document.getElementById("signUpBtn").disabled = true;
    document.getElementById("googleSignInBtn").disabled = true;
    startClock(); // still show clock even if not configured
    return;
  }
  firebase.initializeApp(cfg);
  auth = firebase.auth();
  db = firebase.firestore();

  document.getElementById("signInBtn").addEventListener("click", signIn);
  document.getElementById("signUpBtn").addEventListener("click", signUp);
  document.getElementById("googleSignInBtn").addEventListener("click", signInWithGoogle);
  document.getElementById("signOutBtn").addEventListener("click", ()=>auth.signOut());

  auth.onAuthStateChanged(user=>{
    if (user){
      const allowed = window.ALLOWED_EMAILS || [];
      if (allowed.length && !allowed.includes(user.email)){
        alert("This account (" + user.email + ") is not authorized for this workspace.");
        auth.signOut();
        return;
      }
      currentUser = user;
      showApp();
    } else {
      currentUser = null;
      showLogin();
      if (unsubRooms) unsubRooms();
      if (unsubProspects) unsubProspects();
    }
  });

  startClock();
  wireStaticUI();
}

function signIn(){
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password){
    alert("Enter your email and password.");
    return;
  }
  auth.signInWithEmailAndPassword(email, password).catch(err=>{
    alert("Sign-in failed: " + err.message);
  });
}

function signUp(){
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password){
    alert("Enter your email and password.");
    return;
  }
  auth.createUserWithEmailAndPassword(email, password).catch(err=>{
    alert("Account creation failed: " + err.message);
  });
}

function signInWithGoogle(){
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch(err=>{
    alert("Google sign-in failed: " + err.message);
  });
}

function showLogin(){
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("app").classList.remove("visible");
}

function showApp(){
  const loginScreen = document.getElementById("loginScreen");
  if (loginScreen) loginScreen.style.display = "none";
  document.getElementById("app").classList.add("visible");
  document.getElementById("userName").textContent = currentUser.displayName || currentUser.email;
  document.getElementById("userPhoto").src = currentUser.photoURL || "";
  if (db) subscribeData();
  renderActive();
}

/* ---------------------------- live clock ---------------------------- */

function startClock(){
  const tick = ()=>{
    const now = new Date();
    const timeEl = document.getElementById("clockTime");
    const dateEl = document.getElementById("clockDate");
    if (timeEl) timeEl.textContent = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    if (dateEl) dateEl.textContent = now.toLocaleDateString([], {weekday:'short', year:'numeric', month:'short', day:'numeric'});
  };
  tick();
  setInterval(tick, 1000);
  // Re-render time-sensitive views once a minute so statuses/countdowns stay fresh
  setInterval(()=>{ if (activeTab) renderActive(); }, 60000);
}

/* ---------------------------- firestore sync ---------------------------- */

function subscribeData(){
  unsubRooms = db.collection("rooms").orderBy("room").onSnapshot(snap=>{
    rooms = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderActive();
  }, err=>console.error(err));

  unsubProspects = db.collection("prospects").orderBy("checkIn").onSnapshot(snap=>{
    prospects = snap.docs.map(d=>({id:d.id, ...d.data()}));
    renderActive();
  }, err=>console.error(err));
}

async function importSeedData(){
  if (rooms.length){
    if (!confirm("You already have " + rooms.length + " rooms saved. Import the sample data anyway (it will add alongside, skipping room numbers that already exist)?")) return;
  }
  const existingNumbers = new Set(rooms.map(r=>r.room));
  const batch = db.batch();
  let added = 0;
  window.SEED_ROOMS.forEach((r, i)=>{
    if (existingNumbers.has(r.room)) return;
    const ref = db.collection("rooms").doc();
    batch.set(ref, {
      room: r.room,
      type: "Room",
      capacity: r.capacity,
      gender: r.gender,
      x: 20 + (i % 6) * 150,
      y: 20 + Math.floor(i / 6) * 130,
      beds: r.beds.map(b=>({slot:b.slot, tenant:b.tenant, start:b.start, end:b.end, reservedFor:null}))
    });
    added++;
  });
  await batch.commit();
  alert("Imported " + added + " rooms.");
}

/* ---------------------------- helpers ---------------------------- */

function todayISO(){ return new Date().toISOString().slice(0,10); }

function daysUntil(dateStr){
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d - stripTime(new Date())) / DAY_MS);
}
function stripTime(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

function bedStatus(bed){
  if (!bed.tenant) return "vacant";
  const du = daysUntil(bed.end);
  if (du !== null && du <= 30) return "soon"; // includes overdue (negative)
  return "occupied";
}

function fmtDate(iso){
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString([], {month:'short', day:'numeric', year:'numeric'});
}

function roomVacancy(r){
  const total = r.beds.length;
  const vacant = r.beds.filter(b=>!b.tenant).length;
  return {total, vacant, occupied: total - vacant};
}

function genderMatches(roomGender, prospectGender){
  if (roomGender === "Mixed" || prospectGender === "Any") return true;
  return roomGender === prospectGender;
}

function sameMonth(iso1, iso2){
  if (!iso1 || !iso2) return false;
  const a = new Date(iso1 + "T00:00:00"), b = new Date(iso2 + "T00:00:00");
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/* ============================= RENDER: DASHBOARD ============================= */

function renderDashboard(){
  const totalBeds = rooms.reduce((s,r)=>s + r.beds.length, 0);
  const occBeds = rooms.reduce((s,r)=>s + r.beds.filter(b=>b.tenant).length, 0);
  const vacBeds = totalBeds - occBeds;
  const soonCount = rooms.reduce((s,r)=>s + r.beds.filter(b=>b.tenant && bedStatus(b)==="soon").length, 0);
  const rate = totalBeds ? Math.round((occBeds/totalBeds)*100) : 0;

  document.getElementById("statStrip").innerHTML = `
    <div class="stat-box"><div class="stat-num">${rooms.length}</div><div class="stat-label">Total rooms</div></div>
    <div class="stat-box"><div class="stat-num">${totalBeds}</div><div class="stat-label">Total beds</div></div>
    <div class="stat-box"><div class="stat-num">${occBeds}</div><div class="stat-label">Occupied</div></div>
    <div class="stat-box accent"><div class="stat-num">${vacBeds}</div><div class="stat-label">Vacant now</div></div>
    <div class="stat-box"><div class="stat-num">${rate}%</div><div class="stat-label">Occupancy rate</div></div>
  `;

  const genderFilter = document.getElementById("filterGender").value;
  const vacFilter = document.getElementById("filterVacancy").value;
  const search = document.getElementById("filterSearch").value.trim().toLowerCase();

  let list = rooms.slice();
  if (genderFilter !== "all") list = list.filter(r=>r.gender === genderFilter);
  if (vacFilter === "vacant") list = list.filter(r=>roomVacancy(r).vacant > 0);
  if (vacFilter === "full") list = list.filter(r=>roomVacancy(r).vacant === 0);
  if (search) list = list.filter(r=>{
    if (r.room.toLowerCase().includes(search)) return true;
    return r.beds.some(b=>b.tenant && b.tenant.toLowerCase().includes(search));
  });

  const grid = document.getElementById("roomGrid");
  if (!list.length){
    grid.innerHTML = `<div class="empty-note">No rooms match. ${rooms.length===0 ? 'Click "Add room" to create your first room, or "Import my existing rooms" to load your spreadsheet data.' : 'Try clearing filters.'}</div>`;
    return;
  }

  grid.innerHTML = list.map(r=>{
    const {total, vacant, occupied} = roomVacancy(r);
    const pct = total ? Math.round((occupied/total)*100) : 0;
    const bedsHtml = r.beds.map((b, idx)=>{
      const st = bedStatus(b);
      const du = daysUntil(b.end);
      const reservedProspect = b.reservedFor ? prospects.find(p=>p.id===b.reservedFor) : null;
      let pillLabel = st === "vacant" ? "Vacant" : st === "soon" ? (du<0 ? "Overdue" : du+"d left") : "Occupied";
      return `
        <div class="bed-row">
          <div class="bed-slot">${b.slot}</div>
          <div class="bed-tenant">
            <span class="name ${b.tenant?'':'empty'}">${b.tenant || 'Unassigned bed'}</span>
            <span class="dates">${b.tenant ? fmtDate(b.start) + ' → ' + fmtDate(b.end) : ''}</span>
            ${reservedProspect ? `<span class="reserved-tag">Reserved for ${escapeHtml(reservedProspect.name)} (in ${fmtDate(reservedProspect.checkIn)})</span>` : ''}
          </div>
          <span class="status-pill ${st}">${pillLabel}</span>
        </div>`;
    }).join("");

    return `
      <div class="room-card">
        <div class="room-head">
          <div class="gender-bar ${r.gender}"></div>
          <div>
            <div class="room-code">${escapeHtml(r.room)}</div>
            <div class="room-meta">${r.type || 'Room'} · ${r.gender} · cap ${total}</div>
          </div>
          <div class="spacer"></div>
          <span class="vacancy-pill ${vacant>0?'has':'full'}">${vacant>0 ? vacant+' vacant' : 'Full'}</span>
          <button class="icon-btn" title="Edit room" onclick="openRoomModal('${r.id}')">✎</button>
          <button class="icon-btn" title="Delete room" onclick="deleteRoom('${r.id}')">🗑</button>
        </div>
        <div>${bedsHtml}</div>
        <div class="room-foot">
          <div class="vac-bar"><div class="vac-bar-fill" style="width:${pct}%"></div></div>
          <div class="vac-text">${occupied}/${total} filled</div>
        </div>
      </div>`;
  }).join("");
}

function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================= ROOM MODAL (add/edit) ============================= */

function openRoomModal(roomId){
  editingRoomId = roomId || null;
  const room = roomId ? rooms.find(r=>r.id===roomId) : null;

  document.getElementById("roomModalTitle").textContent = room ? "Edit room " + room.room : "Add room";
  document.getElementById("rmRoomNumber").value = room ? room.room : "";
  document.getElementById("rmType").value = room ? (room.type||"Room") : "Room";
  document.getElementById("rmGender").value = room ? room.gender : "Mixed";
  document.getElementById("rmCapacity").value = room ? room.beds.length : 4;

  renderCapacityChips(room ? room.beds.length : 4);
  renderBedsEditor(room ? room.beds : makeEmptyBeds(4));

  document.getElementById("roomModalBackdrop").classList.add("open");
}

function closeRoomModal(){
  document.getElementById("roomModalBackdrop").classList.remove("open");
  editingRoomId = null;
}

function makeEmptyBeds(n){
  return Array.from({length:n}, (_,i)=>({slot:"Bed "+(i+1), tenant:null, start:null, end:null, reservedFor:null}));
}

function renderCapacityChips(current){
  const wrap = document.getElementById("capacityChips");
  wrap.innerHTML = CAP_PRESETS.map(n=>`<button type="button" class="${n===current?'active':''}" onclick="setCapacity(${n})">${n}</button>`).join("")
    + `<button type="button" class="${!CAP_PRESETS.includes(current)?'active':''}" onclick="promptCustomCapacity()">Custom</button>`;
}

function promptCustomCapacity(){
  const n = parseInt(prompt("How many beds/capacity for this room?", "6"), 10);
  if (n && n > 0 && n <= 20) setCapacity(n);
}

function setCapacity(n){
  document.getElementById("rmCapacity").value = n;
  renderCapacityChips(n);
  const currentBeds = collectBedsFromEditor();
  const newBeds = Array.from({length:n}, (_,i)=> currentBeds[i] || {slot:"Bed "+(i+1), tenant:null, start:null, end:null, reservedFor:null});
  renderBedsEditor(newBeds);
}

function renderBedsEditor(beds){
  const wrap = document.getElementById("bedsEditor");
  wrap.innerHTML = beds.map((b,i)=>`
    <div class="bed-edit-row" data-idx="${i}">
      <div class="field"><label>${b.slot || 'Bed '+(i+1)} — Tenant name</label>
        <input type="text" class="be-tenant" value="${escapeHtml(b.tenant||'')}" placeholder="Leave blank if vacant"></div>
      <div class="field-row">
        <div class="field"><label>Check-in</label><input type="date" class="be-start" value="${b.start||''}"></div>
        <div class="field"><label>Checkout</label><input type="date" class="be-end" value="${b.end||''}"></div>
      </div>
    </div>`).join("");
}

function collectBedsFromEditor(){
  return Array.from(document.querySelectorAll("#bedsEditor .bed-edit-row")).map((row,i)=>{
    const tenant = row.querySelector(".be-tenant").value.trim();
    return {
      slot: "Bed " + (i+1),
      tenant: tenant || null,
      start: tenant ? (row.querySelector(".be-start").value || null) : null,
      end: tenant ? (row.querySelector(".be-end").value || null) : null,
      reservedFor: null
    };
  });
}

async function saveRoom(){
  const roomNumber = document.getElementById("rmRoomNumber").value.trim();
  if (!roomNumber){ alert("Please enter a room number/name."); return; }
  const type = document.getElementById("rmType").value;
  const gender = document.getElementById("rmGender").value;
  const oldBeds = editingRoomId ? rooms.find(r=>r.id===editingRoomId).beds : [];
  const beds = collectBedsFromEditor().map((b,i)=>({...b, reservedFor: oldBeds[i] ? oldBeds[i].reservedFor||null : null}));

  const payload = { room: roomNumber, type, gender, capacity: beds.length, beds };

  if (editingRoomId){
    await db.collection("rooms").doc(editingRoomId).update(payload);
  } else {
    const idx = rooms.length;
    payload.x = 20 + (idx % 6) * 150;
    payload.y = 20 + Math.floor(idx / 6) * 130;
    await db.collection("rooms").add(payload);
  }
  closeRoomModal();
}

async function deleteRoom(id){
  const r = rooms.find(x=>x.id===id);
  if (!confirm("Delete room " + (r?r.room:"") + " and all its bed records? This cannot be undone.")) return;
  await db.collection("rooms").doc(id).delete();
}

/* ============================= RENDER: HALLWAY ============================= */

function renderHallway(){
  const canvas = document.getElementById("hallwayCanvas");
  canvas.innerHTML = rooms.map(r=>{
    const {vacant} = roomVacancy(r);
    const dots = r.beds.map(b=>`<span class="${b.tenant?'occ':'vac'}"></span>`).join("");
    return `<div class="hall-tile" style="left:${r.x||20}px; top:${r.y||20}px" data-id="${r.id}">
      <div class="room-code">${escapeHtml(r.room)}</div>
      <div class="room-meta">${r.gender} · ${vacant} vacant</div>
      <div class="hall-dots">${dots}</div>
    </div>`;
  }).join("");
  wireHallwayDrag();
}

function wireHallwayDrag(){
  const canvas = document.getElementById("hallwayCanvas");
  canvas.querySelectorAll(".hall-tile").forEach(tile=>{
    let dragging = false, offX=0, offY=0;
    tile.addEventListener("pointerdown", e=>{
      dragging = true;
      tile.setPointerCapture(e.pointerId);
      const rect = tile.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
    });
    tile.addEventListener("pointermove", e=>{
      if (!dragging) return;
      const canvasRect = canvas.getBoundingClientRect();
      let x = e.clientX - canvasRect.left - offX + canvas.scrollLeft;
      let y = e.clientY - canvasRect.top - offY + canvas.scrollTop;
      x = Math.max(0, x); y = Math.max(0, y);
      tile.style.left = x + "px";
      tile.style.top = y + "px";
    });
    tile.addEventListener("pointerup", async e=>{
      if (!dragging) return;
      dragging = false;
      const id = tile.dataset.id;
      const x = parseInt(tile.style.left,10), y = parseInt(tile.style.top,10);
      await db.collection("rooms").doc(id).update({x, y});
    });
  });
}

/* ============================= RENDER: ANALYTICS ============================= */

function renderAnalytics(){
  const totalBeds = rooms.reduce((s,r)=>s+r.beds.length,0);
  const occBeds = rooms.reduce((s,r)=>s+r.beds.filter(b=>b.tenant).length,0);
  const vacBeds = totalBeds - occBeds;
  const rate = totalBeds ? Math.round((occBeds/totalBeds)*100) : 0;

  const in30 = rooms.reduce((s,r)=>s+r.beds.filter(b=>b.tenant && daysUntil(b.end)!==null && daysUntil(b.end)<=30).length,0);
  const in60 = rooms.reduce((s,r)=>s+r.beds.filter(b=>b.tenant && daysUntil(b.end)!==null && daysUntil(b.end)<=60).length,0);
  const in90 = rooms.reduce((s,r)=>s+r.beds.filter(b=>b.tenant && daysUntil(b.end)!==null && daysUntil(b.end)<=90).length,0);

  document.getElementById("analyticsTop").innerHTML = `
    <div class="stat-box"><div class="stat-num">${rate}%</div><div class="stat-label">Occupancy rate</div></div>
    <div class="stat-box accent"><div class="stat-num">${vacBeds}</div><div class="stat-label">Vacant beds</div></div>
    <div class="stat-box"><div class="stat-num">${in30}</div><div class="stat-label">Checking out ≤30d</div></div>
    <div class="stat-box"><div class="stat-num">${in90}</div><div class="stat-label">Checking out ≤90d</div></div>
  `;

  const byGender = {Male:0, Female:0, Mixed:0};
  rooms.forEach(r=>{ byGender[r.gender] = (byGender[r.gender]||0) + r.beds.length; });
  const maxG = Math.max(1, ...Object.values(byGender));
  document.getElementById("genderBars").innerHTML = Object.entries(byGender).map(([g,n])=>`
    <div class="bar-row"><div class="label">${g}</div><div class="bar-track"><div class="bar-fill" style="width:${(n/maxG)*100}%"></div></div><div class="val">${n}</div></div>
  `).join("");

  const vacByRoom = rooms.map(r=>({room:r.room, vacant: roomVacancy(r).vacant})).filter(r=>r.vacant>0).sort((a,b)=>b.vacant-a.vacant);
  const maxV = Math.max(1, ...vacByRoom.map(r=>r.vacant));
  document.getElementById("vacancyBars").innerHTML = vacByRoom.length ? vacByRoom.map(r=>`
    <div class="bar-row"><div class="label">Room ${escapeHtml(r.room)}</div><div class="bar-track"><div class="bar-fill" style="width:${(r.vacant/maxV)*100}%"></div></div><div class="val">${r.vacant}</div></div>
  `).join("") : `<div class="empty-note">No vacant beds right now — full house.</div>`;

  document.getElementById("checkoutWindowBars").innerHTML = `
    <div class="bar-row"><div class="label">Next 30 days</div><div class="bar-track"><div class="bar-fill" style="width:${totalBeds?(in30/totalBeds)*100:0}%"></div></div><div class="val">${in30}</div></div>
    <div class="bar-row"><div class="label">Next 60 days</div><div class="bar-track"><div class="bar-fill" style="width:${totalBeds?(in60/totalBeds)*100:0}%"></div></div><div class="val">${in60}</div></div>
    <div class="bar-row"><div class="label">Next 90 days</div><div class="bar-track"><div class="bar-fill" style="width:${totalBeds?(in90/totalBeds)*100:0}%"></div></div><div class="val">${in90}</div></div>
  `;
}

/* ============================= RENDER: MATRIX ============================= */

function renderMatrix(){
  const maxCols = Math.max(1, ...rooms.map(r=>r.beds.length));
  const head = `<tr><th>Room</th>${Array.from({length:maxCols},(_,i)=>`<th>Bed ${i+1}</th>`).join("")}</tr>`;
  const body = rooms.map(r=>{
    const cells = Array.from({length:maxCols},(_,i)=>{
      const b = r.beds[i];
      if (!b) return `<td><div class="matrix-cell none"></div></td>`;
      const st = bedStatus(b);
      const cls = b.reservedFor ? "reserved" : st;
      const label = b.reservedFor ? "R" : st==="vacant" ? "V" : st==="soon" ? "!" : "";
      const title = b.tenant ? `${b.tenant} · ${fmtDate(b.start)} → ${fmtDate(b.end)}` : "Vacant";
      return `<td title="${escapeHtml(title)}"><div class="matrix-cell ${cls}">${label}</div></td>`;
    }).join("");
    return `<tr><td class="roomcell">${escapeHtml(r.room)}</td>${cells}</tr>`;
  }).join("");

  document.getElementById("matrixTable").innerHTML = head + body;
}

/* ============================= RENDER: CHECKOUT CALENDAR ============================= */

function renderCalendar(){
  const base = new Date();
  const target = new Date(base.getFullYear(), base.getMonth() + calOffset, 1);
  const monthLabel = target.toLocaleDateString([], {month:'long', year:'numeric'});
  document.getElementById("calTitle").textContent = monthLabel;

  const items = [];
  rooms.forEach(r=>{
    r.beds.forEach(b=>{
      if (!b.tenant || !b.end) return;
      const d = new Date(b.end + "T00:00:00");
      if (d.getFullYear() === target.getFullYear() && d.getMonth() === target.getMonth()){
        items.push({room:r.room, tenant:b.tenant, date:b.end, reservedFor:b.reservedFor});
      }
    });
  });
  items.sort((a,b)=> a.date.localeCompare(b.date));

  const list = document.getElementById("checkoutList");
  if (!items.length){
    list.innerHTML = `<div class="empty-note">No checkouts scheduled for ${monthLabel}.</div>`;
    return;
  }
  list.innerHTML = items.map(it=>{
    const d = new Date(it.date + "T00:00:00");
    const reservedProspect = it.reservedFor ? prospects.find(p=>p.id===it.reservedFor) : null;
    return `<div class="checkout-item">
      <div class="co-date">${d.toLocaleDateString([],{day:'2-digit'})}<br><small style="font-weight:500;font-size:10px;">${d.toLocaleDateString([],{month:'short'})}</small></div>
      <div class="co-info"><div class="tenant">${escapeHtml(it.tenant)}</div><div class="room">Room ${escapeHtml(it.room)}</div></div>
      ${reservedProspect ? `<span class="co-badge">Next: ${escapeHtml(reservedProspect.name)}</span>` : ''}
    </div>`;
  }).join("");
}

function calNav(delta){ calOffset += delta; renderCalendar(); }
function calToday(){ calOffset = 0; renderCalendar(); }

/* ============================= RENDER: RESERVE / PROSPECTS ============================= */

function findMatchForProspect(p){
  if (p.reservedBed) return null; // already matched — handled separately
  for (const r of rooms){
    for (const b of r.beds){
      if (!b.tenant || !b.end) continue;
      if (b.reservedFor) continue; // already claimed by someone else
      if (!genderMatches(r.gender, p.gender)) continue;
      if (sameMonth(b.end, p.checkIn)){
        return {roomId:r.id, room:r.room, slot:b.slot, tenant:b.tenant, checkoutDate:b.end};
      }
    }
  }
  return null;
}

function renderReserve(){
  const list = document.getElementById("prospectList");
  if (!prospects.length){
    list.innerHTML = `<div class="empty-note">No reserve clients yet. Add one on the left.</div>`;
    return;
  }
  list.innerHTML = prospects.map(p=>{
    let matchHtml;
    if (p.reservedBed){
      const r = rooms.find(rm=>rm.id===p.reservedBed.roomId);
      matchHtml = `<div class="match-box">
        <div class="mtxt">Confirmed → Room ${escapeHtml(r?r.room:'?')}, ${escapeHtml(p.reservedBed.slot)}</div>
        <button class="btn btn-outline btn-sm" onclick="cancelReservation('${p.id}')">Undo</button>
      </div>`;
    } else {
      const m = findMatchForProspect(p);
      if (m){
        matchHtml = `<div class="match-box">
          <div class="mtxt">Match: Room ${escapeHtml(m.room)} ${escapeHtml(m.slot)} — ${escapeHtml(m.tenant)} checks out ${fmtDate(m.checkoutDate)}</div>
          <button class="btn btn-primary btn-sm" onclick='confirmReservation("${p.id}","${m.roomId}","${m.slot}")'>Confirm</button>
        </div>`;
      } else {
        matchHtml = `<div class="match-box none"><div class="mtxt">No matching checkout this month yet — will reappear when a same-month vacancy opens up.</div></div>`;
      }
    }
    return `<div class="prospect-card">
      <div class="top">
        <div><div class="pname">${escapeHtml(p.name)}</div><div class="pmeta">${p.gender} · wants in ${fmtDate(p.checkIn)}${p.checkOut?(' → out '+fmtDate(p.checkOut)):''}</div></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="status-tag ${p.reservedBed?'matched':'searching'}">${p.reservedBed?'Matched':'Searching'}</span>
          <button class="icon-btn" title="Delete" onclick="deleteProspect('${p.id}')">🗑</button>
        </div>
      </div>
      ${p.notes ? `<div class="pmeta" style="margin-top:6px;">${escapeHtml(p.notes)}</div>` : ''}
      ${matchHtml}
    </div>`;
  }).join("");
}

async function addProspect(){
  const name = document.getElementById("pName").value.trim();
  const gender = document.getElementById("pGender").value;
  const checkIn = document.getElementById("pCheckIn").value;
  const checkOut = document.getElementById("pCheckOut").value;
  const notes = document.getElementById("pNotes").value.trim();
  if (!name || !checkIn){ alert("Please enter a name and target check-in date."); return; }
  await db.collection("prospects").add({name, gender, checkIn, checkOut: checkOut||null, notes: notes||null, reservedBed:null});
  document.getElementById("pName").value = "";
  document.getElementById("pCheckIn").value = "";
  document.getElementById("pCheckOut").value = "";
  document.getElementById("pNotes").value = "";
}

async function deleteProspect(id){
  const p = prospects.find(x=>x.id===id);
  if (p && p.reservedBed){
    await db.collection("rooms").doc(p.reservedBed.roomId).update({beds: clearReservationInBeds(p.reservedBed.roomId, id)});
  }
  await db.collection("prospects").doc(id).delete();
}

function clearReservationInBeds(roomId, prospectId){
  const r = rooms.find(x=>x.id===roomId);
  return r.beds.map(b=> b.reservedFor===prospectId ? {...b, reservedFor:null} : b);
}

async function confirmReservation(prospectId, roomId, slot){
  const r = rooms.find(x=>x.id===roomId);
  const newBeds = r.beds.map(b=> b.slot===slot ? {...b, reservedFor:prospectId} : b);
  await db.collection("rooms").doc(roomId).update({beds:newBeds});
  await db.collection("prospects").doc(prospectId).update({reservedBed:{roomId, slot}});
}

async function cancelReservation(prospectId){
  const p = prospects.find(x=>x.id===prospectId);
  if (!p || !p.reservedBed) return;
  const newBeds = clearReservationInBeds(p.reservedBed.roomId, prospectId);
  await db.collection("rooms").doc(p.reservedBed.roomId).update({beds:newBeds});
  await db.collection("prospects").doc(prospectId).update({reservedBed:null});
}

/* ============================= TAB / NAV WIRING ============================= */

function renderActive(){
  switch(activeTab){
    case "dashboard": renderDashboard(); break;
    case "hallway": renderHallway(); break;
    case "analytics": renderAnalytics(); break;
    case "matrix": renderMatrix(); break;
    case "calendar": renderCalendar(); break;
    case "reserve": renderReserve(); break;
  }
}

function switchTab(tab){
  activeTab = tab;
  document.querySelectorAll("nav.tabs button").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active", v.id==="view-"+tab));
  renderActive();
}

function wireStaticUI(){
  document.querySelectorAll("nav.tabs button").forEach(b=>{
    b.addEventListener("click", ()=>switchTab(b.dataset.tab));
  });

  document.getElementById("addRoomBtn").addEventListener("click", ()=>openRoomModal(null));
  document.getElementById("addRoomBtn2").addEventListener("click", ()=>openRoomModal(null));
  document.getElementById("importSeedBtn").addEventListener("click", importSeedData);
  document.getElementById("closeRoomModal").addEventListener("click", closeRoomModal);
  document.getElementById("cancelRoomModal").addEventListener("click", closeRoomModal);
  document.getElementById("saveRoomBtn").addEventListener("click", saveRoom);
  document.getElementById("roomModalBackdrop").addEventListener("click", e=>{ if (e.target.id==="roomModalBackdrop") closeRoomModal(); });

  ["filterGender","filterVacancy"].forEach(id=>document.getElementById(id).addEventListener("change", renderDashboard));
  document.getElementById("filterSearch").addEventListener("input", renderDashboard);

  document.getElementById("calPrev").addEventListener("click", ()=>calNav(-1));
  document.getElementById("calNext").addEventListener("click", ()=>calNav(1));
  document.getElementById("calTodayBtn").addEventListener("click", calToday);

  document.getElementById("addProspectBtn").addEventListener("click", addProspect);
}

boot();
