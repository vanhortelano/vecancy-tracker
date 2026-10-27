/* Viewer page: Google sign-in -> dorm code + password -> read-only vacancy list.
   Viewers can only read dorms/{code}/vacancy (no resident names). */
(function(){
  const $ = id => document.getElementById(id);
  const SECTIONS = ["vConfigWarning","vSignIn","vJoin","vMessage","vBoard"];
  function show(name){
    SECTIONS.forEach(id=>{ $(id).hidden = id !== name; });
    $("vAuthShell").hidden = name !== "vSignIn" && name !== "vJoin";
  }
  function applyTheme(dark){
    document.body.classList.toggle("v-dark", dark);
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    $("vThemeToggle").setAttribute("aria-label", label);
    $("vThemeToggle").title = label;
    $("vThemeIcon").className = dark ? "fa-solid fa-sun" : "fa-solid fa-moon";
  }
  try{ applyTheme(localStorage.getItem("loginTheme") === "dark"); }
  catch(error){ applyTheme(false); }
  $("vThemeToggle").addEventListener("click", ()=>{
    const dark = !document.body.classList.contains("v-dark");
    applyTheme(dark);
    try{ localStorage.setItem("loginTheme", dark ? "dark" : "light"); }
    catch(error){ console.error("Could not save viewer theme", error); }
  });
  $("vPasswordToggle").addEventListener("click", ()=>{
    const input = $("vPassword");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    $("vPasswordToggle").setAttribute("aria-label", visible ? "Hide password" : "Show password");
    $("vPasswordToggle").innerHTML = `<i class="fa-regular ${visible ? "fa-eye-slash" : "fa-eye"}"></i>`;
  });

  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || cfg.apiKey === "YOUR_API_KEY"){ show("vConfigWarning"); return; }
  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const db = firebase.firestore();
  if (location.protocol !== "file:"){
    auth.getRedirectResult().catch(error=>{
      $("vSignInError").textContent = "Google sign-in failed: " + authErrorMessage(error);
    });
  }

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
        return auth.signInWithRedirect(provider).catch(redirectError=>{
          $("vSignInError").textContent = "Google sign-in failed: " + authErrorMessage(redirectError);
        });
      }
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
      $("vSignInError").textContent = "Google sign-in failed: " + authErrorMessage(err);
    });
  });
  $("vSignOut").addEventListener("click", ()=>auth.signOut());
  $("vBackToSignIn").addEventListener("click", ()=>auth.signOut());
  $("vTryAgainBtn").addEventListener("click", ()=>{
    $("vJoinError").textContent = "";
    show("vJoin");
  });
  ["vCode","vPassword"].forEach(id=>{
    $(id).addEventListener("keydown", event=>{
      if (event.key === "Enter") $("vJoinBtn").click();
    });
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
      error.textContent = !code || !password
        ? "Enter the dorm code and password."
        : "Dorm codes must be 4–30 characters using letters, numbers, and dashes.";
      return;
    }
    const button = $("vJoinBtn");
    button.disabled = true;
    try{
      const viewerRef = db.collection("dorms").doc(code).collection("viewers").doc(user.uid);
      const proof = await viewerProof(code, password);
      const existing = await viewerRef.get();
      if (existing.exists && existing.data().proof !== proof){
        error.textContent = "That dorm code and password do not match. Check them with your administrator.";
        return;
      }
      if (!existing || !existing.exists){
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
        ? "Could not join with those details. Check the code and password, or ask your admin if viewer access is enabled."
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

  function authErrorMessage(error){
    const messages = {
      "auth/operation-not-allowed":"Google sign-in is disabled. Ask the administrator to enable Google in Firebase Authentication.",
      "auth/unauthorized-domain":"This site domain is not authorized in Firebase Authentication settings.",
      "auth/popup-blocked":"The sign-in popup was blocked. Allow popups for this site and try again.",
      "auth/operation-not-supported-in-this-environment":"Open the viewer through HTTPS or localhost to use Google sign-in.",
      "auth/network-request-failed":"Network error. Check your connection and try again."
    };
    return messages[error.code] || error.message || "Please try again.";
  }

  $("vFilterStatus").addEventListener("change", renderBoard);
  $("vFilterGender").addEventListener("change", renderBoard);
})();
