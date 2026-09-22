/* ==========================================================================
   firebase-layer.js — ชั้นเชื่อมต่อ Firebase (Authentication + Firestore)
   ระบบงานโจรกรรม หมวดทางหลวงเชิงเนิน (ฉบับ Firestore — สำเนาแยกจากระบบ Apps Script เดิม)
   สร้างในรูปแบบเดียวกับระบบงานอุบัติเหตุ (โครงสร้างฐานข้อมูลและกฎความปลอดภัยแบบเดียวกัน) แต่ใช้โปรเจกต์ Firebase คนละโปรเจกต์

   ทำหน้าที่แทน Code.gs เดิมทั้งหมด:
     - ล็อกอิน/ล็อกเอาต์ (Firebase Auth) และจัดการทีม (เพิ่ม/ลบ/ตั้งรหัสผ่านใหม่)
     - อ่านข้อมูลแบบ realtime (onSnapshot) + เก็บแคชในเครื่อง ทำให้เปิดครั้งต่อไปเร็วและอ่านเฉพาะส่วนที่เปลี่ยน
     - เขียนข้อมูล พร้อมบันทึก activity_log ในคำสั่งเดียวกัน (atomic batch) — แทน LockService + logActivity
     - soft delete / restore / ลบถาวร (เจ้าของระบบเท่านั้น — บังคับที่ Firestore Rules ไม่ใช่แค่ปุ่มในหน้าเว็บ)
     - เติมข้อมูลอ้างอิงตั้งต้น (สายทาง + ราคากลางทรัพย์สิน) และนำเข้าข้อมูลจากไฟล์ Excel ที่ export จาก Google Sheet เดิม

   คอลเลกชัน: thefts (เคสโจรกรรม), team, materials, routes, zones (เขตพื้นที่รับผิดชอบ), activity_log, config, presence

   หมายเหตุ: ค่า firebaseConfig ด้านล่างเป็นค่าสาธารณะโดยออกแบบ (ไม่ใช่รหัสลับ)
   ความปลอดภัยจริงอยู่ที่ firestore.rules
   ========================================================================== */
(function () {
  'use strict';

  // ▼▼▼ วางค่าจาก Firebase Console ตรงนี้ (โปรเจกต์ใหม่สำหรับงานโจรกรรม) ▼▼▼
  // Firebase Console → Project settings (⚙) → General → Your apps → Web app (</>) → SDK setup and configuration → Config
  // ขั้นตอนละเอียดดูใน "คู่มือติดตั้ง-อ่านก่อน.md"
  const firebaseConfig = {
    apiKey: "AIzaSyB5PdmQAq7XtwAk9OgJTO8wpH_PqMX6Aog",
    authDomain: "choengnoen-theft.firebaseapp.com",
    projectId: "choengnoen-theft",
    storageBucket: "choengnoen-theft.firebasestorage.app",
    messagingSenderId: "963253312362",
    appId: "1:963253312362:web:2178dc3c30f8b5afa56313"
  };
  // ▲▲▲ ─────────────────────────────────────────────────────────────── ▲▲▲

  // ระบบล็อกอินด้วยชื่อ-นามสกุล แต่ Firebase Auth ต้องการอีเมล จึงสร้างอีเมลสังเคราะห์ให้แต่ละคน
  // (โดเมน .invalid เป็นโดเมนที่ไม่มีอยู่จริงตามมาตรฐาน — ไม่มีการส่งอีเมลใดๆ ออกไปทั้งสิ้น)
  const EMAIL_DOMAIN = 'theft.invalid';
  const CASE_COL = 'thefts';

  const FBL = {};
  window.FBL = FBL;
  // ยังไม่ได้วางค่า firebaseConfig → หน้าเว็บจะแสดงข้อความแนะนำแทนหน้าล็อกอิน
  FBL.configured = !/^YOUR_/.test(String(firebaseConfig.apiKey || '')) && !/^YOUR_/.test(String(firebaseConfig.projectId || ''));

  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  if (FBL.configured) {
    try {
      db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
        console.warn('Firestore offline cache unavailable:', e && e.code);
      });
    } catch (e) { /* เบราว์เซอร์ที่ไม่รองรับ — ทำงานต่อแบบไม่มีแคช */ }
  }

  FBL.user = null;          // { uid, name, isOwner } เมื่อล็อกอินแล้ว
  FBL.onError = null;       // callback(message) สำหรับข้อผิดพลาดจาก realtime listener
  let team = [];            // [{ uid, name, email, isOwner }]
  let suppressAuthEvents = false;

  /* ---------- ข้อความผิดพลาดภาษาไทย ---------- */
  function thErr(e) {
    const code = (e && e.code) || '';
    const map = {
      'auth/invalid-credential': 'รหัสผ่านไม่ถูกต้อง',
      'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
      'auth/invalid-login-credentials': 'รหัสผ่านไม่ถูกต้อง',
      'auth/user-not-found': 'ไม่พบบัญชีนี้ในระบบ',
      'auth/too-many-requests': 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
      'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่',
      'auth/weak-password': 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร',
      'auth/email-already-in-use': 'เกิดบัญชีซ้ำโดยบังเอิญ กรุณาลองอีกครั้ง',
      'auth/requires-recent-login': 'กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่ก่อนเปลี่ยนรหัสผ่าน',
      'auth/operation-not-allowed': 'ยังไม่ได้เปิดการเข้าสู่ระบบแบบ Email/Password ใน Firebase Console',
      'auth/unauthorized-domain': 'โดเมนนี้ยังไม่ได้รับอนุญาตใน Firebase (Authentication → Settings → Authorized domains)',
      'permission-denied': 'ไม่มีสิทธิ์ทำรายการนี้ (ตรวจสอบว่าได้วางกฎ firestore.rules แล้ว และล็อกอินด้วยบัญชีที่มีสิทธิ์)',
      'unavailable': 'เชื่อมต่อฐานข้อมูลไม่ได้ในขณะนี้ กรุณาลองใหม่',
      'failed-precondition': 'ฐานข้อมูลไม่พร้อมทำรายการนี้'
    };
    return map[code] || ((e && e.message) ? e.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  }
  FBL.errorText = thErr;

  function nowIso() { return new Date().toISOString(); }
  function randomId(n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').slice(0, n);
  }
  function newEmail() { return 'm-' + randomId(12) + '@' + EMAIL_DOMAIN; }
  function requireOwner() {
    if (!FBL.user || !FBL.user.isOwner) throw new Error('เฉพาะเจ้าของระบบเท่านั้น');
  }
  // Firestore ไม่รับ undefined และ NaN/Infinity
  function clean(o) {
    const out = {};
    Object.keys(o).forEach(function (k) {
      let v = o[k];
      if (v === undefined) return;
      if (typeof v === 'number' && !isFinite(v)) v = null;
      out[k] = v;
    });
    return out;
  }
  function asJsonString(v) {
    if (v === undefined || v === null || v === '') return '[]';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  /* ---------- ทีม / ล็อกอิน ---------- */
  // อ่านรายชื่อทีมได้ก่อนล็อกอิน (ใช้แสดงรายชื่อให้เลือกในหน้าล็อกอิน) — มีเฉพาะชื่อ/อีเมลสังเคราะห์/สถานะเจ้าของ ไม่มีรหัสผ่าน
  FBL.loadTeam = async function () {
    const snap = await db.collection('team').get();
    team = snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
    team.sort(function (a, b) { return (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'th'); });
    return team.slice();
  };
  FBL.team = function () { return team.slice(); };

  // ต้องเรียกครั้งเดียวตอนเริ่มระบบ — cb(user|null, errorMessage?)
  FBL.onAuth = function (cb) {
    auth.onAuthStateChanged(async function (u) {
      if (suppressAuthEvents) return;
      if (!u) { FBL.user = null; cb(null); return; }
      try {
        const d = await db.collection('team').doc(u.uid).get();
        if (!d.exists) {
          FBL.user = null;
          await auth.signOut();
          cb(null, 'บัญชีนี้ไม่ได้อยู่ในรายชื่อเจ้าหน้าที่ กรุณาติดต่อเจ้าของระบบ');
          return;
        }
        FBL.user = { uid: u.uid, name: d.data().name, isOwner: !!d.data().isOwner };
        cb(FBL.user);
      } catch (e) {
        FBL.user = null;
        cb(null, thErr(e));
      }
    });
  };

  FBL.login = async function (name, password) {
    const m = team.find(function (x) { return x.name === String(name || '').trim(); });
    if (!m) throw new Error('ไม่พบชื่อนี้ในระบบ');
    try {
      await auth.signInWithEmailAndPassword(m.email, password);
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.logout = async function () {
    // แจ้งว่าออฟไลน์ก่อนออกจากระบบ (รอไม่เกิน 2 วินาที ถ้าเน็ตหลุดก็ข้ามไป)
    try { await Promise.race([presenceWrite(false), new Promise(function (r) { setTimeout(r, 2000); })]); } catch (e) { /* ข้าม */ }
    FBL.stopPresence();
    await auth.signOut();
    FBL.stopAll();
  };

  /* ---------- สถานะออนไลน์ (เจ้าของระบบเห็นใน "ระบบควบคุมการเข้าใช้งาน") ----------
     ทุกคนที่ล็อกอินอยู่เขียนเอกสาร presence/{uid} ของตัวเอง 1 ครั้งทุก 2 นาที เฉพาะตอนที่เปิดหน้าเว็บอยู่
     (เขียนแบบไม่รอผล ล้มเหลวก็ข้ามเงียบๆ ไม่กระทบการใช้งาน) — เจ้าของระบบเท่านั้นที่อ่านได้ (ดู firestore.rules) */
  const PRESENCE_EVERY_MS = 120000;
  let presenceTimer = null;
  let presenceOnVisible = null;
  let presenceOnHide = null;
  function presenceWrite(online) {
    if (!FBL.user) return Promise.resolve();
    return db.collection('presence').doc(FBL.user.uid).set({
      name: FBL.user.name,
      online: online,
      lastSeen: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(function () { /* ข้ามเงียบๆ */ });
  }
  FBL.startPresence = function () {
    FBL.stopPresence();
    presenceWrite(true);
    presenceTimer = setInterval(function () { if (document.visibilityState === 'visible') presenceWrite(true); }, PRESENCE_EVERY_MS);
    presenceOnVisible = function () { if (document.visibilityState === 'visible') presenceWrite(true); };
    presenceOnHide = function () { presenceWrite(false); };
    document.addEventListener('visibilitychange', presenceOnVisible);
    window.addEventListener('pagehide', presenceOnHide);
  };
  FBL.stopPresence = function () {
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (presenceOnVisible) { document.removeEventListener('visibilitychange', presenceOnVisible); presenceOnVisible = null; }
    if (presenceOnHide) { window.removeEventListener('pagehide', presenceOnHide); presenceOnHide = null; }
  };

  // ตั้งเจ้าของระบบคนแรก — Rules อนุญาตเฉพาะตอนที่ยังไม่มีเอกสาร config/bootstrap และจะปิดประตูนี้ทันทีหลังสำเร็จ
  FBL.bootstrapOwner = async function (name, password) {
    name = String(name || '').trim();
    if (!name) throw new Error('กรอกชื่อ-นามสกุลก่อน');
    suppressAuthEvents = true;
    try {
      const email = newEmail();
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      const uid = cred.user.uid;
      try {
        const batch = db.batch();
        batch.set(db.collection('team').doc(uid), { name: name, email: email, isOwner: true, createdAt: nowIso() });
        batch.set(db.collection('config').doc('bootstrap'), { uid: uid, at: nowIso() });
        await batch.commit();
      } catch (e) {
        try { await cred.user.delete(); } catch (_) { /* ล้างบัญชีที่ค้าง */ }
        throw e;
      }
      FBL.user = { uid: uid, name: name, isOwner: true };
      team = [{ uid: uid, name: name, email: email, isOwner: true }];
      return FBL.user;
    } catch (e) {
      throw new Error(thErr(e));
    } finally {
      suppressAuthEvents = false;
    }
  };

  // สร้างบัญชี Auth โดยไม่ทำให้เจ้าของระบบหลุดจากเซสชัน (ใช้แอปรองแยกต่างหาก)
  async function createAuthUserSecondary(email, password) {
    const sec = firebase.apps.find(function (a) { return a.name === 'secondary'; }) || firebase.initializeApp(firebaseConfig, 'secondary');
    const cred = await sec.auth().createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await sec.auth().signOut();
    return uid;
  }

  FBL.addMember = async function (name, password) {
    requireOwner();
    name = String(name || '').trim();
    if (!name) throw new Error('กรอกชื่อ-นามสกุลก่อน');
    if (team.some(function (t) { return t.name === name; })) throw new Error('มีชื่อนี้เป็นเจ้าหน้าที่อยู่แล้ว');
    try {
      const email = newEmail();
      const uid = await createAuthUserSecondary(email, password);
      await db.collection('team').doc(uid).set({ name: name, email: email, isOwner: false, createdAt: nowIso() });
      team.push({ uid: uid, name: name, email: email, isOwner: false });
    } catch (e) { throw new Error(thErr(e)); }
  };

  FBL.removeMember = async function (name) {
    requireOwner();
    const m = team.find(function (t) { return t.name === name; });
    if (!m) return;
    if (m.isOwner) throw new Error('ลบเจ้าของระบบไม่ได้');
    try {
      await db.collection('team').doc(m.uid).delete();
      team = team.filter(function (t) { return t.uid !== m.uid; });
    } catch (e) { throw new Error(thErr(e)); }
  };

  // เจ้าของระบบไม่สามารถแก้รหัสผ่านของ "คนอื่น" ตรงๆ ได้ (ข้อจำกัดของ Firebase ฝั่งเบราว์เซอร์)
  // จึงสร้างบัญชีล็อกอินใหม่ให้คนนั้นด้วยรหัสผ่านใหม่ แล้วสลับรายชื่อ — ผลต่อผู้ใช้เหมือนตั้งรหัสผ่านใหม่
  FBL.resetMemberPassword = async function (name, newPassword) {
    requireOwner();
    const m = team.find(function (t) { return t.name === name; });
    if (!m) throw new Error('ไม่พบชื่อนี้ในรายชื่อ');
    try {
      if (FBL.user && m.uid === FBL.user.uid) {
        await auth.currentUser.updatePassword(newPassword);
        return;
      }
      const email = newEmail();
      const uid = await createAuthUserSecondary(email, newPassword);
      const batch = db.batch();
      batch.delete(db.collection('team').doc(m.uid));
      batch.set(db.collection('team').doc(uid), { name: m.name, email: email, isOwner: !!m.isOwner, createdAt: nowIso() });
      await batch.commit();
      team = team.filter(function (t) { return t.uid !== m.uid; });
      team.push({ uid: uid, name: m.name, email: email, isOwner: !!m.isOwner });
    } catch (e) { throw new Error(thErr(e)); }
  };

  /* ---------- อ่านข้อมูลแบบ realtime ---------- */
  const subs = {};
  // คืน Promise ที่ resolve เมื่อได้ข้อมูลชุดแรก; การเปลี่ยนแปลงถัดไปเรียก onChange(collection, docs)
  FBL.watch = function (col, onChange) {
    if (subs[col]) { subs[col].onChange = onChange || subs[col].onChange; return subs[col].first; }
    const s = subs[col] = { docs: [], firstDone: false, onChange: onChange };
    s.first = new Promise(function (resolve) {
      s.unsub = db.collection(col).onSnapshot(function (snap) {
        s.docs = snap.docs.map(function (d) { return Object.assign({}, d.data(), { __id: d.id }); });
        if (!s.firstDone) { s.firstDone = true; resolve(s.docs); }
        else if (s.onChange) { try { s.onChange(col, s.docs); } catch (e) { console.error(e); } }
      }, function (err) {
        console.error('watch ' + col + ' failed', err);
        if (FBL.onError && col !== 'presence') FBL.onError(thErr(err));   // presence: ยังไม่ได้ประกาศ Rules ก็ไม่ต้องเตือน
        if (!s.firstDone) { s.firstDone = true; resolve([]); }
      });
    });
    return s.first;
  };
  FBL.docs = function (col) { return subs[col] ? subs[col].docs : []; };
  FBL.stopAll = function () {
    Object.keys(subs).forEach(function (k) { if (subs[k].unsub) subs[k].unsub(); delete subs[k]; });
  };

  /* ---------- เขียนข้อมูลเคสโจรกรรม (+ activity_log ใน batch เดียวกัน) ---------- */
  function logRef() { return db.collection('activity_log').doc(); }
  function logEntry(action, sheetName, recordId, snapshot) {
    return {
      ts: firebase.firestore.FieldValue.serverTimestamp(),
      actorName: FBL.user ? FBL.user.name : '(ไม่ทราบผู้ทำรายการ)',
      actorUid: FBL.user ? FBL.user.uid : '',
      action: action,
      sheetName: sheetName,
      recordId: recordId,
      snapshot: JSON.stringify(snapshot || {})
    };
  }
  async function readBefore(ref) {
    try { const d = await ref.get(); return d.exists ? d.data() : {}; } catch (e) { return {}; }
  }

  FBL.saveTheft = async function (rec, isNew) {
    const ref = db.collection(CASE_COL).doc(String(rec.id));
    const data = clean(Object.assign({}, rec, {
      items: asJsonString(rec.items)
    }));
    let before = {};
    if (!isNew) before = await readBefore(ref);
    if (isNew) { data.deletedAt = null; data.deletedBy = ''; }
    const batch = db.batch();
    batch.set(ref, data, { merge: true });
    batch.set(logRef(), logEntry(isNew ? 'add' : 'update', CASE_COL, rec.id, isNew ? {} : before));
    await batch.commit();
  };

  FBL.softDeleteTheft = async function (id) {
    const ref = db.collection(CASE_COL).doc(String(id));
    const before = await readBefore(ref);
    const batch = db.batch();
    batch.update(ref, { deletedAt: nowIso(), deletedBy: FBL.user ? FBL.user.name : '' });
    batch.set(logRef(), logEntry('delete', CASE_COL, id, before));
    await batch.commit();
  };

  FBL.restoreTheft = async function (id) {
    const ref = db.collection(CASE_COL).doc(String(id));
    const batch = db.batch();
    batch.update(ref, { deletedAt: null, deletedBy: '' });
    batch.set(logRef(), logEntry('restore', CASE_COL, id, {}));
    await batch.commit();
  };

  FBL.permanentDeleteTheft = async function (id) {
    requireOwner();
    const ref = db.collection(CASE_COL).doc(String(id));
    const before = await readBefore(ref);
    const batch = db.batch();
    batch.delete(ref);
    batch.set(logRef(), logEntry('permanentDelete', CASE_COL, id, before));
    await batch.commit();
  };

  /* ---------- วัสดุ/ทรัพย์สิน, สายทาง และเขตพื้นที่รับผิดชอบ ---------- */
  FBL.saveMaterial = async function (m) {
    requireOwner();
    const key = String(m.key);
    const data = clean({
      key: key, name: m.name, unit: m.unit, price: m.price, updatedAt: m.updatedAt,
      category: m.category, frequent: m.frequent, hidden: m.hidden
    });
    await db.collection('materials').doc(key).set(data, { merge: true });
  };

  function routeData(r) {
    return clean({
      highway: String(r.highway), controlNo: r.controlNo || '', section: r.section || '',
      kmRanges: asJsonString(r.kmRanges),
      distanceActual: r.distanceActual === undefined ? null : r.distanceActual,
      distance2Lane: r.distance2Lane === undefined ? null : r.distance2Lane,
      asphalt: r.asphalt === undefined ? null : r.asphalt,
      concrete: r.concrete === undefined ? null : r.concrete,
      workQty: r.workQty === undefined ? null : r.workQty,
      // สถานะสายทาง: active = หมวดฯ ดูแลอยู่ / transferred = โอนให้หมวดอื่นแล้ว (เก็บไว้เพื่อคงเคสเก่า)
      status: r.status === 'transferred' ? 'transferred' : 'active',
      transferredDate: r.transferredDate || '',
      transferNote: r.transferNote || '',
      updatedAt: r.updatedAt || ''
    });
  }
  FBL.saveRoute = async function (r) {
    await db.collection('routes').doc(String(r.highway)).set(routeData(r), { merge: true });
  };
  FBL.deleteRoute = async function (highway) {
    await db.collection('routes').doc(String(highway)).delete();
  };

  // เขตพื้นที่รับผิดชอบ: ช่วง กม. (หน่วยเมตร) → สภ./ตำบล/อำเภอ/จังหวัด/หมู่ — ใช้เติมข้อมูลอัตโนมัติตอนบันทึกเคส
  function zoneData(z) {
    return clean({
      id: String(z.id), highway: String(z.highway || ''),
      kmStart: Number(z.kmStart) || 0, kmEnd: Number(z.kmEnd) || 0,
      station: z.station || '', tambon: z.tambon || '', amphoe: z.amphoe || '', changwat: z.changwat || '',
      moobans: asJsonString(z.moobans),
      updatedAt: z.updatedAt || ''
    });
  }
  FBL.saveZone = async function (z) {
    requireOwner();
    await db.collection('zones').doc(String(z.id)).set(zoneData(z), { merge: true });
  };
  FBL.deleteZone = async function (id) {
    requireOwner();
    await db.collection('zones').doc(String(id)).delete();
  };

  /* ==========================================================================
     เติมข้อมูลอ้างอิงตั้งต้น (เจ้าของระบบเท่านั้น): สายทางของหมวดฯ + ราคากลางทรัพย์สิน
     - ข้ามรายการที่มีอยู่แล้ว (ไม่ทับที่เจ้าของระบบแก้ไว้) — รันซ้ำได้ปลอดภัย
     ========================================================================== */
  FBL.seedReference = async function (seed, progress) {
    requireOwner();
    const report = [];
    const today = nowIso().slice(0, 10);

    const rSnap = await db.collection('routes').get();
    const haveRoutes = new Set(rSnap.docs.map(function (d) { return d.id; }));
    const routeWrites = (seed.routes || []).filter(function (r) { return !haveRoutes.has(String(r.highway)); }).map(function (r) {
      return { ref: db.collection('routes').doc(String(r.highway)), data: routeData(Object.assign({ updatedAt: today }, r)), merge: true };
    });
    await commitInChunks(routeWrites, progress, 'สายทาง');
    report.push('สายทาง: เพิ่มใหม่ ' + routeWrites.length + ' สาย (มีอยู่แล้ว ' + ((seed.routes || []).length - routeWrites.length) + ')');

    const mSnap = await db.collection('materials').get();
    const haveKey = new Set(), haveName = new Set();
    mSnap.docs.forEach(function (d) { haveKey.add(d.id); const n = d.data().name; if (n) haveName.add(n); });
    const matWrites = (seed.materials || []).filter(function (m) { return m.key && !haveKey.has(String(m.key)) && !haveName.has(m.name); }).map(function (m) {
      return {
        ref: db.collection('materials').doc(String(m.key)),
        data: clean({ key: String(m.key), name: m.name, unit: m.unit, price: Number(m.price) || 0, updatedAt: today,
                      category: m.category || '', frequent: m.frequent === undefined ? null : m.frequent, hidden: false })
      };
    });
    await commitInChunks(matWrites, progress, 'ทรัพย์สิน/วัสดุ');
    report.push('ราคากลางทรัพย์สิน: เพิ่มใหม่ ' + matWrites.length + ' รายการ (มีอยู่แล้ว ' + ((seed.materials || []).length - matWrites.length) + ')');
    return report;
  };

  /* ==========================================================================
     นำเข้าข้อมูลจากไฟล์ Excel ที่ export จาก Google Sheet ของระบบเดิม (เจ้าของระบบเท่านั้น)
     - รันซ้ำได้ปลอดภัย: ใช้รหัสเดิมของแต่ละแถวเป็นรหัสเอกสาร (เขียนทับของเดิมเท่านั้น ไม่เกิดซ้ำ)
     - ไม่นำเข้าแท็บ team (รหัสผ่านย้ายไม่ได้)
     - ระบบเดิมเก็บ กม. เป็นทศนิยม (เช่น 6.500) และเลขทางหลวงเป็น "ทล.3145" — ตัวนำเข้าแปลงเป็นเมตร / เลขล้วน ให้ตรงกับระบบนี้
     ========================================================================== */
  function serialToDate(n) { return new Date(Math.round((n - 25569) * 86400000)); }
  function toDateStr(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') return serialToDate(v).toISOString().slice(0, 10);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : String(v);
  }
  function toIso(v) {
    if (v === '' || v === null || v === undefined) return '';
    if (typeof v === 'number') return serialToDate(v).toISOString();
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }
  function toBool(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
  function toNum(v) { if (v === '' || v === null || v === undefined) return ''; const n = Number(v); return isFinite(n) ? n : ''; }
  function toNumOrNull(v) { const n = toNum(v); return n === '' ? null : n; }
  function toStr(v) { return (v === null || v === undefined) ? '' : String(v); }
  function stripHw(v) { return toStr(v).replace(/^\s*ทล\.?\s*/, '').trim(); }
  function kmToMeters(v) { const n = toNum(v); return n === '' ? null : Math.round(n * 1000); }
  function fiscalYearOf(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})-(\d{2})/);
    return m ? Number(m[1]) + 543 + (Number(m[2]) >= 10 ? 1 : 0) : '';
  }
  function parseJsonArr(v) {
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function mapTheft(r) {
    const dateIncident = toDateStr(r.dateIncident);
    const items = parseJsonArr(r.items).map(function (it) {
      return {
        name: toStr(it.name || it.material), qty: toStr(it.qty), unit: toStr(it.unit),
        unitPrice: toNumOrNull(it.unitPrice), price: toNumOrNull(it.price != null ? it.price : it.lineTotal)
      };
    });
    const total = toNum(r.grandTotal !== undefined && r.grandTotal !== '' ? r.grandTotal : r.totalPrice);
    let tambon = toStr(r.tambon), amphoe = toStr(r.amphoe);
    if (!tambon && !amphoe && r.tambonAmphoe) {
      const p = toStr(r.tambonAmphoe).split('/');
      tambon = (p[0] || '').trim(); amphoe = (p[1] || '').trim();
    }
    const status = toStr(r.status) || 'แจ้งความเบื้องต้น';
    return {
      id: toStr(r.id), fiscalYear: fiscalYearOf(dateIncident),
      dateIncident: dateIncident, dateFound: toDateStr(r.dateFound), time: toStr(r.time),
      highway: stripHw(r.highway !== undefined && r.highway !== '' ? r.highway : r.route),
      section: toStr(r.section), km: kmToMeters(r.km), side: toStr(r.side),
      location: toStr(r.location || r.locationDetail),
      policeStation: toStr(r.policeStation), tambon: tambon, amphoe: amphoe, changwat: toStr(r.changwat), moo: toStr(r.moo),
      caseNo: toStr(r.caseNo), reportLetterNo: toStr(r.reportLetterNo), reportedDate: toDateStr(r.reportedDate),
      policeOfficer: toStr(r.policeOfficer), policePhone: toStr(r.policePhone),
      suspectStatus: toStr(r.suspectStatus), suspectName: toStr(r.suspectName),
      items: JSON.stringify(items),
      materialsTotal: total, totalPrice: total,
      status: status, closedDate: status === 'ปิดคดี' ? toDateStr(r.closedDate) : '', note: toStr(r.note),
      assignedBy: toStr(r.assignedBy), assignLetterNo: toStr(r.assignLetterNo), assignDate: toDateStr(r.assignDate),
      assignedToName: toStr(r.assignedToName), assignedToPosition: toStr(r.assignedToPosition), assignedToPhone: toStr(r.assignedToPhone),
      recordedBy: toStr(r.recordedBy), createdAt: toIso(r.createdAt), updatedAt: toIso(r.updatedAt),
      imported: true,
      deletedAt: r.deletedAt === '' || r.deletedAt == null ? null : toIso(r.deletedAt),
      deletedBy: toStr(r.deletedBy)
    };
  }
  function mapMaterial(r) {
    const f = String(r.frequent).toUpperCase();
    return {
      key: toStr(r.key), name: toStr(r.name), unit: toStr(r.unit), price: toNum(r.price) === '' ? 0 : toNum(r.price),
      updatedAt: toDateStr(r.updatedAt), hidden: toBool(r.hidden), category: toStr(r.category),
      frequent: f === 'TRUE' ? true : (f === 'FALSE' ? false : null)
    };
  }
  function mapRoute(r) {
    let control = r.controlNo;
    if (typeof control === 'number') control = String(control).padStart(4, '0');
    const ranges = parseJsonArr(r.kmRanges).map(function (p) { return [Math.round(Number(p[0]) * 1000), Math.round(Number(p[1]) * 1000)]; });
    return {
      highway: stripHw(r.highway), controlNo: toStr(control), section: toStr(r.section),
      kmRanges: JSON.stringify(ranges),
      distanceActual: toNumOrNull(r.distanceActual), distance2Lane: toNumOrNull(r.distance2Lane),
      asphalt: toNumOrNull(r.asphalt), concrete: toNumOrNull(r.concrete), workQty: toNumOrNull(r.workQty),
      updatedAt: toDateStr(r.updatedAt)
    };
  }
  function mapZone(r) {
    return {
      id: toStr(r.id), highway: stripHw(r.route !== undefined && r.route !== '' ? r.route : r.highway),
      kmStart: kmToMeters(r.kmStart) || 0, kmEnd: kmToMeters(r.kmEnd) || 0,
      station: toStr(r.station), tambon: toStr(r.tambon), amphoe: toStr(r.amphoe), changwat: toStr(r.changwat),
      moobans: JSON.stringify(parseJsonArr(r.moobans).map(String)),
      updatedAt: toDateStr(r.updatedAt)
    };
  }

  async function commitInChunks(writes, progress, label) {
    const CHUNK = 400; // Firestore จำกัด 500 คำสั่งต่อ batch
    let done = 0;
    for (let i = 0; i < writes.length; i += CHUNK) {
      const batch = db.batch();
      writes.slice(i, i + CHUNK).forEach(function (w) { if (w.merge) batch.set(w.ref, w.data, { merge: true }); else batch.set(w.ref, w.data); });
      await batch.commit();
      done += Math.min(CHUNK, writes.length - i);
      if (progress) progress(label + ': ' + done + '/' + writes.length);
    }
  }

  // XLSXlib = ตัวแปร XLSX (SheetJS) ที่หน้าเว็บโหลดไว้แล้ว, buffer = ArrayBuffer ของไฟล์ .xlsx
  FBL.importWorkbook = async function (XLSXlib, buffer, progress) {
    requireOwner();
    const wb = XLSXlib.read(buffer, { type: 'array' });
    function rows(name) {
      const ws = wb.Sheets[name];
      if (!ws) return null;
      return XLSXlib.utils.sheet_to_json(ws, { defval: '', raw: true });
    }
    const report = [];

    const cases = rows('cases') || rows('thefts');
    if (!cases) throw new Error('ไม่พบแท็บ "cases" ในไฟล์ — ตรวจสอบว่าเลือกไฟล์ถูกต้อง');
    const caseWrites = cases.filter(function (r) { return String(r.id || '').trim() !== ''; }).map(function (r) {
      const d = mapTheft(r);
      return { ref: db.collection(CASE_COL).doc(d.id), data: d };
    });
    await commitInChunks(caseWrites, progress, 'เคสโจรกรรม');
    report.push('เคสโจรกรรม ' + caseWrites.length + ' รายการ (รวมที่อยู่ในถังขยะ ' + caseWrites.filter(function (w) { return w.data.deletedAt; }).length + ')');

    const mats = rows('materials');
    if (mats) {
      const w = mats.filter(function (r) { return String(r.key || '').trim() !== ''; }).map(function (r) {
        const d = mapMaterial(r); return { ref: db.collection('materials').doc(d.key), data: d };
      });
      await commitInChunks(w, progress, 'ทรัพย์สิน/วัสดุ');
      report.push('ทรัพย์สิน/วัสดุ ' + w.length + ' รายการ');
    }

    const routes = rows('routes');
    if (routes) {
      const w = routes.filter(function (r) { return String(r.highway || '').trim() !== ''; }).map(function (r) {
        const d = mapRoute(r); return { ref: db.collection('routes').doc(d.highway), data: d, merge: true };
      });
      await commitInChunks(w, progress, 'สายทาง');
      report.push('สายทาง ' + w.length + ' รายการ');
    }

    const zones = rows('zones');
    if (zones) {
      const w = zones.filter(function (r) { return String(r.id || '').trim() !== ''; }).map(function (r) {
        const d = mapZone(r); return { ref: db.collection('zones').doc(d.id), data: d };
      });
      await commitInChunks(w, progress, 'เขตพื้นที่รับผิดชอบ');
      report.push('เขตพื้นที่รับผิดชอบ ' + w.length + ' รายการ');
    }

    const logs = rows('activity_log');
    if (logs) {
      const w = logs.map(function (r, i) {
        const t = typeof r.timestamp === 'number' ? serialToDate(r.timestamp) : new Date(r.timestamp);
        return {
          ref: db.collection('activity_log').doc('imp-' + (i + 1)),
          data: {
            ts: firebase.firestore.Timestamp.fromDate(isNaN(t.getTime()) ? new Date(0) : t),
            actorName: toStr(r.actorName), actorUid: '', action: toStr(r.action),
            sheetName: toStr(r.sheetName), recordId: toStr(r.recordId), snapshot: toStr(r.snapshot), imported: true
          }
        };
      });
      await commitInChunks(w, progress, 'ประวัติการทำรายการ');
      report.push('ประวัติการทำรายการ ' + w.length + ' รายการ');
    }
    return report;
  };
})();
