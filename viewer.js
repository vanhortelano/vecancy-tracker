/* Viewer page: Google sign-in -> dorm code + password -> read-only vacancy list.
   Viewers can only read dorms/{code}/vacancy (no resident names). */
(function(){
  const $ = id => document.getElementById(id);
  const SECTIONS = ["vConfigWarning","vSignIn","vJoin","vMessage","vBoard"];
  function show(name){ SECTIONS.forEach(id=>{ $(id).hidden = id !== name; }); }

  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.apiKey === "YOUR_API_KEY"){ show("vConfigWarning"); return; }
  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();

  let unsubViewerDoc = null, unsubVacancy = null;
  let vacancyRooms = [];
  let currentUser = null;

  function savedKey(user){ return "viewerDorm:" + user.uid; }
  function readSaved(user){ try{ return localStorage.getItem(savedKey(user)); }catch(e){ return null; } }
  function writeSaved(user, code){ try{ localStorage.setItem(savedKey(user), code); }catch(e){} }
  function clearSaved(user){ try{ localStorage.removeItem(savedKey(user)); }catch(e){} }

  function stopListening(){
    if (unsubViewerDoc) unsubViewerDoc();
    if (unsubVacancy) unsubVacancy();
    unsubViewerDoc = null;
    unsubVacancy = null;
    vacancyRooms = [];
  }

  function showEnded(title, text){
    stopListening();
    if (currentUser) clearSaved(currentUser);
    $("vMessageTitle").textContent = title;
    $("vMessageText").textContent = text;
    show("vMessage");
  }

  /* ---------------- sign in ---------------- */
  $("vGoogleBtn").addEventListener("click", ()=>{
    $("vSignInError").textContent = "";
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err=>{
      if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment"){
        return auth.signInWithRedirect(provider);
      }
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
      $("vSignInError").textContent = "Google sign-in failed: " + err.message;
    });
  });
  $("vSignOut").addEventListener("click", ()=>auth.signOut());
  $("vTryAgainBtn").addEventListener("click", ()=>{
    $("vJoinError").textContent = "";
    show("vJoin");
  });

  auth.onAuthStateChanged(async user=>{
    stopListening();
    currentUser = user;
    if (!user){
      $("vUser").hidden = true;
      show("vSignIn");
      return;
    }
    $("vUser").hidden = false;
    $("vUserName").textContent = user.displayName || user.email || "";
    const saved = readSaved(user);
    if (saved){
      try{
        const snap = await db.collection("dorms").doc(saved).collection("viewers").doc(user.uid).get();
        if (snap.exists){ startBoard(user, saved); return; }
      }catch(error){ /* fall through to the join form */ }
      clearSaved(user);
    }
    show("vJoin");
  });

  /* ---------------- join ---------------- */
  $("vJoinBtn").addEventListener("click", async ()=>{
    const user = auth.currentUser;
    const error = $("vJoinError");
    error.textContent = "";
    if (!user) return;
    const code = normalizeDormCode($("vCode").value);
    const password = $("vPassword").value;
    if (!isValidDormCode(code) || !password){
      error.textContent = "Enter the dorm code and the password.";
      return;
    }
    const button = $("vJoinBtn");
    button.disabled = true;
    try{
      const viewerRef = db.collection("dorms").doc(code).collection("viewers").doc(user.uid);
      let existing = null;
      try{ existing = await viewerRef.get(); }catch(e){ existing = null; }
      if (!existing || !existing.exists){
        const proof = await viewerProof(code, password);
        await viewerRef.set({
          proof,
          name: user.displayName || "",
          email: user.email || "",
          joinedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
      $("vPassword").value = "";
      writeSaved(user, code);
      startBoard(user, code);
    }catch(err){
      console.error("Join failed", err);
      error.textContent = err.code === "permission-denied"
        ? "That didn't work. Check the dorm code and password, or ask your admin — access may be turned off or removed."
        : "Could not join: " + err.message;
    }finally{
      button.disabled = false;
    }
  });

  /* ---------------- vacancy board ---------------- */
  function startBoard(user, code){
    stopListening();
    show("vBoard");
    const dorm = db.collection("dorms").doc(code);
    unsubViewerDoc = dorm.collection("viewers").doc(user.uid).onSnapshot(snap=>{
      if (!snap.exists) showEnded("Access ended", "The admin removed your access. Ask them if you think this is a mistake.");
    }, ()=>showEnded("Access ended", "You no longer have access to this dorm."));
    unsubVacancy = dorm.collection("vacancy").onSnapshot(snap=>{
      vacancyRooms = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderBoard();
    }, err=>{
      if (err.code === "permission-denied") showEnded("Access ended", "The admin turned off viewer access or removed you.");
      else console.error("Vacancy listener failed", err);
    });
  }

  function renderBoard(){
    const statusFilter = $("vFilterStatus").value;
    const genderFilter = $("vFilterGender").value;
    const sorted = vacancyRooms.slice().sort((a,b)=>String(a.room).localeCompare(String(b.room), undefined, {numeric:true}));
    const vacantRooms = sorted.filter(r=>r.vacant > 0).length;
    const vacantBeds = sorted.reduce((sum,r)=>sum + (r.vacant||0), 0);
    $("vSummary").innerHTML =
      `<div class="v-stat good"><b>${vacantBeds}</b><span>Vacant beds</span></div>` +
      `<div class="v-stat good"><b>${vacantRooms}</b><span>Rooms with space</span></div>` +
      `<div class="v-stat"><b>${sorted.length - vacantRooms}</b><span>Full rooms</span></div>`;
    const list = sorted.filter(r=>(statusFilter==="all" || (statusFilter==="vacant" ? r.vacant>0 : r.vacant===0)) &&
      (genderFilter==="all" || r.gender===genderFilter));
    $("vGrid").innerHTML = list.length ? list.map(r=>{
      const full = !(r.vacant > 0);
      return `<div class="v-room ${esc(r.gender)}">
        <h3>Room ${esc(r.room)}</h3>
        <div class="v-meta">${esc(r.gender||"Mixed")}${r.demographic && r.demographic!=="Mixed" ? " · "+esc(r.demographic) : ""} · ${r.total||0} bed${r.total===1?"":"s"}</div>
        <span class="v-pill ${full?"full":"vacant"}">${full ? "Full" : r.vacant + " vacant"}</span>
      </div>`;
    }).join("") : `<div class="v-empty">${vacancyRooms.length ? "No rooms match this filter." : "The admin hasn't published any rooms yet."}</div>`;
    $("vUpdated").textContent = "Live — updates automatically when the admin changes a room.";
  }

  function esc(value){
    return String(value==null?"":value).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }

  $("vFilterStatus").addEventListener("change", renderBoard);
  $("vFilterGender").addEventListener("change", renderBoard);
})();
