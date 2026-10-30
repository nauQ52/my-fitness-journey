// ---------- Configuration ----------
const CLIENT_ID = '688686897331-6peocc5ll0i1amob9slvgnfl51j4gvsr.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'My Fitness Journey';
const KEY = 'mfj_workouts';

// ---------- App State & DOM Helpers ----------
const $ = s => document.querySelector(s);
const COL = { run: '#b6ff00', cycle: '#00e5ff' };
const S = { type: 'run', pts: [], dist: 0, t0: 0, el: 0, watch: null, timer: null, startPhoto: null, endPhoto: null, on: false };

let accessToken = localStorage.getItem('mfj_drive_token') || null;
let tokenClient = null;
let driveFolderId = localStorage.getItem('mfj_folder_id') || null;
let driveWorkoutsCache = [];

// ---------- Data Storage Abstraction (Drive + LocalStorage Fallback) ----------
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
const saveLocal = (ws) => { try { localStorage.setItem(KEY, JSON.stringify(ws)); } catch (e) {} };

async function loadWorkouts() {
  if (accessToken) {
    try {
      const driveWorkouts = await fetchDriveWorkouts();
      driveWorkoutsCache = driveWorkouts;
      return driveWorkouts;
    } catch (e) {
      console.warn('Lỗi lấy dữ liệu từ Google Drive, chuyển sang lưu trữ cục bộ:', e);
      if (e.status === 401) handleSignOut();
    }
  }
  return loadLocal();
}

// ---------- Google Drive API Integration ----------
function initGoogleAuth() {
  if (typeof google === 'undefined' || !google.accounts) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        console.error('Auth error:', resp);
        return;
      }
      accessToken = resp.access_token;
      localStorage.setItem('mfj_drive_token', accessToken);
      updateAuthUI(true);
      await ensureDriveFolder();
      if (!$('#hist').classList.contains('hidden')) renderHist();
    },
  });
  if (accessToken) updateAuthUI(true);
}
window.onload = () => { setTimeout(initGoogleAuth, 500); };

function handleAuthClick() {
  if (!accessToken) {
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
    else alert('Đang tải thư viện Google... Vui lòng thử lại sau vài giây.');
  } else {
    handleSignOut();
  }
}

function handleSignOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  driveFolderId = null;
  localStorage.removeItem('mfj_drive_token');
  localStorage.removeItem('mfj_folder_id');
  updateAuthUI(false);
  if (!$('#hist').classList.contains('hidden')) renderHist();
}

function updateAuthUI(signedIn) {
  const txt = $('#authTxt');
  const btn = $('#authBtn');
  if (signedIn) {
    txt.textContent = t('signOut');
    btn.classList.remove('neon');
    btn.classList.add('border', 'border-zinc-600');
  } else {
    txt.textContent = t('signIn');
    btn.classList.add('neon');
    btn.classList.remove('border', 'border-zinc-600');
  }
}

async function driveApiFetch(url, options = {}) {
  options.headers = options.headers || {};
  options.headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = new Error(`Drive API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function ensureDriveFolder() {
  if (driveFolderId) return driveFolderId;
  const q = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const res = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${q}`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    driveFolderId = data.files[0].id;
  } else {
    const createRes = await driveApiFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    const folder = await createRes.json();
    driveFolderId = folder.id;
  }
  localStorage.setItem('mfj_folder_id', driveFolderId);
  return driveFolderId;
}

// Tạo thư mục con cho từng buổi tập bên trong thư mục chính
async function createWorkoutSubFolder(folderName) {
  const parentId = await ensureDriveFolder();
  const createRes = await driveApiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const folder = await createRes.json();
  return folder.id;
}

async function uploadFileToDriveInFolder(folderId, name, mimeType, content, isBase64 = false) {
  const metadata = { name, parents: [folderId] };
  let body, contentType;

  if (isBase64) {
    const boundary = 'foo_bar_baz';
    contentType = `multipart/related; boundary=${boundary}`;
    const base64Data = content.replace(/^data:(.*);base64,/, '');
    body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Data}\r\n--${boundary}--`;
  } else {
    const boundary = 'foo_bar_baz';
    contentType = `multipart/related; boundary=${boundary}`;
    body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
  }

  const res = await driveApiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body
  });
  return await res.json();
}

async function fetchDriveWorkouts() {
  const parentId = await ensureDriveFolder();
  // Tìm tất cả các thư mục con (buổi tập) nằm trong "My Fitness Journey"
  const qFolders = encodeURIComponent(`'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const resFolders = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${qFolders}&fields=files(id,name)&orderBy=createdTime desc`);
  const dataFolders = await resFolders.json();

  const workouts = [];

  // Duyệt qua từng thư mục con để tìm file JSON buổi tập bên trong
  for (const folder of (dataFolders.files || [])) {
    const qFiles = encodeURIComponent(`'${folder.id}' in parents and mimeType = 'application/json' and trashed = false`);
    const resFiles = await driveApiFetch(`https://www.googleapis.com/drive/v3/files?q=${qFiles}&fields=files(id,name)`);
    const dataFiles = await resFiles.json();

    if (dataFiles.files && dataFiles.files.length > 0) {
      const jsonFile = dataFiles.files[0];
      try {
        const fileRes = await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${jsonFile.id}?alt=media`);
        const w = await fileRes.json();
        w._driveId = jsonFile.id;
        w._subFolderId = folder.id; // Lưu lại ID thư mục con để tiện xoá nếu cần
        workouts.push(w);
      } catch (e) {
        console.warn('Không đọc được file workout:', e);
      }
    }
  }
  return workouts;
}

async function deleteDriveWorkout(workout) {
  // Xóa thư mục con chứa buổi tập (Google Drive sẽ tự động xóa các file bên trong thư mục đó)
  if (workout._subFolderId) {
    await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${workout._subFolderId}`, { method: 'DELETE' });
  } else if (workout._driveId) {
    // Trường hợp dữ liệu cũ lưu dạng đơn lẻ
    await driveApiFetch(`https://www.googleapis.com/drive/v3/files/${workout._driveId}`, { method: 'DELETE' });
  }
}

// ---------- Formatting & Calculations ----------
const fmtT = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60, p = n => String(n).padStart(2, '0'); return (h ? h + ':' : '') + p(m) + ':' + p(x); };
const fmtPace = (km, s, type) => { if (km < 0.02) return '--'; if (type === 'cycle') return (km / (s / 3600)).toFixed(1); const p = s / 60 / km; return Math.floor(p) + ':' + String(Math.round(p % 1 * 60)).padStart(2, '0').replace(/^60$/, '59'); };
const kcal = (km, type, kg) => Math.round(km * kg * (type === 'run' ? 1.0 : 0.4));
const hav = (a, b) => { const R = 6371e3, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const setColor = t => document.documentElement.style.setProperty('--c', COL[t]);

// ---------- i18n (EN / VN) ----------
const T = {
  en: { tTrack: 'Track', tHist: 'History', run: '🏃 Running', cycle: '🚴 Cycling', time: 'time', startPh: 'Start photo (optional)', weight: 'Your weight (kg), for calories:', finTitle: 'Finish workout', endPh: 'End photo (optional)', notesPh: 'Notes: how did it feel?', discard: 'Discard', saveBtn: 'Save workout', dl: '⬇ Download PNG (1920×1080)', close: 'Close', cam: '📷 Take a photo', up: '🖼 Choose from gallery', noPh: 'No photo yet', phOk: '✓ Photo added', rmPh: '✕ Remove', start: '▶ START WORKOUT', stop: '■ FINISH', noLoc: 'Location unavailable. Allow GPS access (HTTPS required).', gpsErr: 'GPS error: ', tracking: 'Tracking… keep this screen on.', nogeo: 'Geolocation not supported.', fullNoPh: 'Storage full: saved without photos.', full: 'Storage full. Delete old workouts.', delConf: 'Delete this workout?', empty: 'No workouts yet. Go get moving! 💪', workouts: 'workouts', total: 'total', runS: '🏃 Run', rideS: '🚴 Ride', shareBtn: 'Share card', RUN: 'RUNNING', CYC: 'CYCLING', dist: 'DISTANCE (KM)', tm: 'TIME', pace: 'PACE (/KM)', speed: 'SPEED (KM/H)', cPace: 'PACE PROFILE', cSpeed: 'SPEED PROFILE', render: 'Rendering…', signIn: 'Sign in with Google', signOut: 'Sign out', uploading: 'Uploading to Google Drive…' },
  vi: { tTrack: 'Theo dõi', tHist: 'Lịch sử', run: '🏃 Chạy bộ', cycle: '🚴 Đạp xe', time: 'thời gian', startPh: 'Ảnh bắt đầu (tuỳ chọn)', weight: 'Cân nặng (kg), để tính calo:', finTitle: 'Kết thúc buổi tập', endPh: 'Ảnh kết thúc (tuỳ chọn)', notesPh: 'Ghi chú: bạn cảm thấy thế nào?', discard: 'Huỷ bỏ', saveBtn: 'Lưu buổi tập', dl: '⬇ Tải ảnh PNG (1920×1080)', close: 'Đóng', cam: '📷 Chụp ảnh ngay', up: '🖼 Chọn từ thư viện', noPh: 'Chưa có ảnh', phOk: '✓ Đã thêm ảnh', rmPh: '✕ Xoá ảnh', start: '▶ BẮT ĐẦU TẬP', stop: '■ KẾT THÚC', noLoc: 'Không lấy được vị trí. Hãy cho phép GPS (cần HTTPS).', gpsErr: 'Lỗi GPS: ', tracking: 'Đang theo dõi… hãy giữ màn hình sáng.', nogeo: 'Trình duyệt không hỗ trợ định vị.', fullNoPh: 'Bộ nhớ đầy: đã lưu nhưng không kèm ảnh.', full: 'Bộ nhớ đầy. Hãy xoá bớt buổi tập cũ.', delConf: 'Xoá buổi tập này?', empty: 'Chưa có buổi tập nào. Bắt đầu thôi! 💪', workouts: 'buổi tập', total: 'tổng cộng', runS: '🏃 Chạy', rideS: '🚴 Đạp xe', shareBtn: 'Tạo thẻ chia sẻ', RUN: 'CHẠY BỘ', CYC: 'ĐẠP XE', dist: 'QUÃNG ĐƯỜNG (KM)', tm: 'THỜI GIAN', pace: 'PACE (/KM)', speed: 'TỐC ĐỘ (KM/H)', cPace: 'BIỂU ĐỒ PACE', cSpeed: 'BIỂU ĐỒ TỐC ĐỘ', render: 'Đang tạo ảnh…', signIn: 'Đăng nhập Google', signOut: 'Đăng xuất', uploading: 'Đang tải lên Google Drive…' }
};

let LANG = localStorage.getItem('mfj_lang') || ((navigator.language || '').startsWith('vi') ? 'vi' : 'en');
const t = k => T[LANG][k] || k, loc = () => LANG === 'vi' ? 'vi-VN' : 'en-US';
const paceL = () => { $('#mPaceL').textContent = S.type === 'run' ? 'min/km' : 'km/h'; };
const setGo = () => { $('#goBtn').textContent = S.on ? t('stop') : t('start'); };

function applyLang() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i]').forEach(e => e.textContent = t(e.dataset.i));
  document.querySelectorAll('[data-ip]').forEach(e => e.placeholder = t(e.dataset.ip));
  setGo();
  if (accessToken) $('#authTxt').textContent = t('signOut');
  const a = 'color:var(--c)';
  $('#lang').innerHTML = `<span style="${LANG === 'en' ? a : ''}">EN</span> | <span style="${LANG === 'vi' ? a : ''}">VN</span>`;
}

$('#lang').onclick = () => {
  LANG = LANG === 'en' ? 'vi' : 'en';
  try { localStorage.setItem('mfj_lang', LANG); } catch (e) {}
  applyLang();
  if (!$('#hist').classList.contains('hidden')) renderHist();
  if (!$('#share').classList.contains('hidden')) openShare(window._sid);
};
$('#authBtn').onclick = handleAuthClick;
applyLang();

// ---------- Tabs & type ----------
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
  $('#track').classList.toggle('hidden', b.dataset.t !== 'track');
  $('#hist').classList.toggle('hidden', b.dataset.t !== 'hist');
  if (b.dataset.t === 'hist') renderHist(); else map.invalidateSize();
});

document.querySelectorAll('#types button').forEach(b => b.onclick = () => {
  if (S.on) return;
  S.type = b.dataset.ty;
  setColor(S.type);
  document.querySelectorAll('#types button').forEach(x => x.classList.toggle('neon', x === b));
  paceL();
  poly.setStyle({ color: COL[S.type] });
  document.getElementById('map').style.setProperty('--c', COL[S.type]);
});

// ---------- Map ----------
const map = L.map('map', { zoomControl: false }).setView([16.07, 108.2], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles', attribution: '© OpenStreetMap' }).addTo(map);
const poly = L.polyline([], { color: COL.run, weight: 6, opacity: .95, className: 'glow' }).addTo(map);
document.getElementById('map').style.setProperty('--c', COL.run);
const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', fillColor: '#3b82f6', fillOpacity: 1, weight: 3 });
navigator.geolocation && navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 16), () => { $('#gpsMsg').textContent = t('noLoc'); });

// ---------- Photos ----------
function resize(file, max = 640) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => {
      const i = new Image();
      i.onload = () => {
        const k = Math.min(1, max / Math.max(i.width, i.height)), c = document.createElement('canvas');
        c.width = i.width * k; c.height = i.height * k;
        c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', .72));
      };
      i.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

function picker(el, key) {
  el.innerHTML = `<div class="flex gap-3 items-center">
    <div class="w-20 h-20 shrink-0 rounded-xl border-2 border-dashed border-zinc-600 flex items-center justify-center text-3xl overflow-hidden bg-zinc-900 relative">
      <span class="phi">📷</span><img class="hidden absolute inset-0 w-full h-full object-cover"></div>
    <div class="flex-1 space-y-2">
      <label class="btn neon block text-center text-sm cursor-pointer"><span data-i="cam"></span><input type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn block text-center text-sm cursor-pointer border border-zinc-600"><span data-i="up"></span><input type="file" accept="image/*" hidden></label>
      <div class="flex items-center justify-between text-xs"><span class="st" data-i="noPh"></span><button type="button" class="rm hidden text-red-400 font-semibold" data-i="rmPh"></button></div>
    </div></div>`;
  const im = el.querySelector('img'), st = el.querySelector('.st'), rm = el.querySelector('.rm'), ic = el.querySelector('.phi');
  const show = () => {
    const on = !!S[key];
    im.classList.toggle('hidden', !on);
    if (on) im.src = S[key];
    ic.classList.toggle('hidden', on);
    rm.classList.toggle('hidden', !on);
    st.dataset.i = on ? 'phOk' : 'noPh';
    st.className = 'st ' + (on ? 'text-lime-400' : 'text-zinc-500');
    st.textContent = t(st.dataset.i);
  };
  el.querySelectorAll('input').forEach(inp => inp.onchange = async () => { if (inp.files[0]) { S[key] = await resize(inp.files[0]); show(); } inp.value = ''; });
  rm.onclick = () => { S[key] = null; show(); };
  applyLang(); show();
}
picker($('#startPick'), 'startPhoto'); picker($('#endPick'), 'endPhoto');

// ---------- Tracking ----------
function tick() {
  S.el = (Date.now() - S.t0) / 1000;
  const kg = +$('#weight').value || 70, km = S.dist / 1000;
  $('#mDist').textContent = km.toFixed(2);
  $('#mTime').textContent = fmtT(S.el);
  $('#mPace').textContent = fmtPace(km, S.el, S.type);
  $('#mCal').textContent = kcal(km, S.type, kg);
}

function onPos(p) {
  const c = p.coords; if (c.accuracy > 40) return;
  const pt = [c.latitude, c.longitude, Date.now()], last = S.pts[S.pts.length - 1];
  if (last) { const d = hav(last, pt); if (d < 4 || d > 150) return; S.dist += d; }
  S.pts.push(pt); poly.addLatLng([pt[0], pt[1]]); me.setLatLng([pt[0], pt[1]]).addTo(map); map.panTo([pt[0], pt[1]]);
}

$('#goBtn').onclick = () => {
  if (!S.on) {
    if (!navigator.geolocation) return alert(t('nogeo'));
    Object.assign(S, { pts: [], dist: 0, t0: Date.now(), on: true }); poly.setLatLngs([]);
    S.watch = navigator.geolocation.watchPosition(onPos, e => $('#gpsMsg').textContent = t('gpsErr') + e.message, { enableHighAccuracy: true, maximumAge: 0 });
    S.timer = setInterval(tick, 1000);
    setGo(); $('#goBtn').style.background = '#ff3355'; $('#goBtn').style.color = '#fff';
    $('#startBox').classList.add('hidden'); $('#gpsMsg').textContent = t('tracking');
    navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {});
  } else {
    navigator.geolocation.clearWatch(S.watch); clearInterval(S.timer); tick(); $('#finish').classList.remove('hidden');
  }
};

function reset() {
  S.on = false; S.startPhoto = S.endPhoto = null; $('#finish').classList.add('hidden'); $('#notes').value = '';
  setGo(); $('#goBtn').style.cssText = ''; $('#startBox').classList.remove('hidden');
  ['#mDist', '#mCal'].forEach(s => $(s).textContent = s === '#mDist' ? '0.00' : '0');
  $('#mTime').textContent = '00:00'; $('#mPace').textContent = '--';
  picker($('#startPick'), 'startPhoto'); picker($('#endPick'), 'endPhoto'); poly.setLatLngs([]); me.remove(); $('#gpsMsg').textContent = '';
}
$('#discard').onclick = reset;

$('#save').onclick = async () => {
  const saveBtn = $('#save');
  saveBtn.disabled = true;
  saveBtn.textContent = accessToken ? t('uploading') : 'Đang lưu...';

  let pts = S.pts;
  if (pts.length > 500) {
    const k = pts.length / 500;
    pts = Array.from({ length: 500 }, (_, i) => S.pts[Math.floor(i * k)]).concat([S.pts[S.pts.length - 1]]);
  }

  const workoutId = Date.now();
  const workoutDate = new Date();
  const typeLabel = S.type === 'run' ? 'Chạy' : 'ĐạpXe';
  
  // Format tên thư mục theo ngày giờ (Ví dụ: Chạy_2026-10-29_22-30)
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${workoutDate.getFullYear()}-${pad(workoutDate.getMonth() + 1)}-${pad(workoutDate.getDate())}_${pad(workoutDate.getHours())}-${pad(workoutDate.getMinutes())}`;
  const subFolderName = `${typeLabel}_${dateStr}`;

  const workout = {
    id: workoutId,
    type: S.type,
    date: workoutDate.toISOString(),
    dist: S.dist / 1000,
    dur: S.el,
    kcal: kcal(S.dist / 1000, S.type, +$('#weight').value || 70),
    pts,
    startPhoto: S.startPhoto,
    endPhoto: S.endPhoto,
    notes: $('#notes').value.trim()
  };

  if (accessToken) {
    try {
      // 1. Tạo thư mục con riêng cho buổi tập này trên Google Drive
      const subFolderId = await createWorkoutSubFolder(subFolderName);
      workout._subFolderId = subFolderId;

      // 2. Lưu ảnh bắt đầu vào thư mục con nếu có
      if (workout.startPhoto) {
        await uploadFileToDriveInFolder(subFolderId, 'anh_bat_dau.jpg', 'image/jpeg', workout.startPhoto, true);
      }
      // 3. Lưu ảnh kết thúc vào thư mục con nếu có
      if (workout.endPhoto) {
        await uploadFileToDriveInFolder(subFolderId, 'anh_ket_thuc.jpg', 'image/jpeg', workout.endPhoto, true);
      }
      // 4. Lưu file JSON chi tiết buổi tập vào thư mục con
      const jsonRes = await uploadFileToDriveInFolder(subFolderId, 'chi_tiet_buoi_tap.json', 'application/json', JSON.stringify(workout, null, 2));
      workout._driveId = jsonRes.id;

    } catch (e) {
      console.error('Lỗi khi lưu lên Google Drive:', e);
      alert('Tải lên Google Drive thất bại. Đã chuyển sang lưu trữ cục bộ.');
      saveLocal([workout, ...loadLocal()]);
    }
  } else {
    try {
      saveLocal([workout, ...loadLocal()]);
    } catch (e) {
      workout.startPhoto = workout.endPhoto = null;
      try { saveLocal([workout, ...loadLocal()]); alert(t('fullNoPh')); } catch (e2) { alert(t('full')); }
    }
  }

  saveBtn.disabled = false;
  saveBtn.textContent = t('saveBtn');
  reset();
  document.querySelector('[data-t=hist]').click();
};

// ---------- Drawing helpers ----------
function drawRoute(cv, pts, color, lw = 4) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, pad = Math.min(W, H) * .1; g.clearRect(0, 0, W, H);
  if (pts.length < 2) { g.fillStyle = '#555'; g.font = '14px sans-serif'; g.textAlign = 'center'; g.fillText('No route data', W / 2, H / 2); return; }
  const la = pts.map(p => p[0]), lo = pts.map(p => p[1]), kx = Math.cos(la[0] * Math.PI / 180);
  const x0 = Math.min(...lo) * kx, x1 = Math.max(...lo) * kx, y0 = Math.min(...la), y1 = Math.max(...la);
  const s = Math.min((W - 2 * pad) / ((x1 - x0) || 1e-5), (H - 2 * pad) / ((y1 - y0) || 1e-5)), ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
  const P = p => [ox + (p[1] * kx - x0) * s, H - (oy + (p[0] - y0) * s)];
  g.lineJoin = g.lineCap = 'round'; g.strokeStyle = color; g.lineWidth = lw; g.shadowColor = color; g.shadowBlur = lw * 4; g.beginPath();
  pts.forEach((p, i) => { const [x, y] = P(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.shadowBlur = 0;
  [[pts[0], '#fff'], [pts[pts.length - 1], '#ff3355']].forEach(([p, c]) => { const [x, y] = P(p); g.fillStyle = c; g.beginPath(); g.arc(x, y, lw * 1.4, 0, 7); g.fill(); });
}

function speeds(w) {
  const p = w.pts, out = [];
  if (p.length > 8) {
    for (let i = 4; i < p.length; i += 2) {
      let d = 0; for (let j = i - 4; j < i; j++) d += hav(p[j], p[j + 1]);
      const dt = (p[i][2] - p[i - 4][2]) / 1000;
      out.push(dt > 0 ? Math.min(60, d / dt * 3.6) : 0);
    }
  }
  if (out.length < 6) {
    const base = w.dist / (w.dur / 3600 || 1) || 10;
    for (let i = 0; i < 40; i++) out.push(base * (1 + .18 * Math.sin(i / 4) + .08 * Math.sin(i * 1.3)));
  }
  return out;
}

function drawChart(cv, w, color) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, v = speeds(w), mx = Math.max(...v) * 1.1, mn = Math.min(...v) * .8; g.clearRect(0, 0, W, H);
  const X = i => i / (v.length - 1) * W, Y = x => H - 8 - (x - mn) / (mx - mn || 1) * (H - 16);
  const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, color + '88'); gr.addColorStop(1, color + '00');
  g.beginPath(); g.moveTo(0, H); v.forEach((x, i) => g.lineTo(X(i), Y(x))); g.lineTo(W, H); g.fillStyle = gr; g.fill();
  g.beginPath(); v.forEach((x, i) => i ? g.lineTo(X(i), Y(x)) : g.moveTo(X(i), Y(x))); g.strokeStyle = color; g.lineWidth = 3; g.shadowColor = color; g.shadowBlur = 10; g.stroke();
}

// ---------- History ----------
// ---------- History & Calendar ----------

// Hàm tạo giao diện lịch chấm xanh (đậm nhạt theo tổng km)
function renderCalendar(workouts) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const firstDay = new Date(y, m, 1).getDay();

  // Gom nhóm tổng quãng đường theo từng ngày trong tháng
  const dayDist = {};
  let maxDist = 0;
  workouts.forEach(w => {
    const d = new Date(w.date);
    if (d.getFullYear() === y && d.getMonth() === m) {
      const date = d.getDate();
      dayDist[date] = (dayDist[date] || 0) + w.dist;
      if (dayDist[date] > maxDist) maxDist = dayDist[date];
    }
  });

  let html = `<div class="calendar"><div class="cal-header">Tháng ${m + 1} năm ${y}</div><div class="cal-grid">`;
  const days = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
  days.forEach(d => html += `<div class="cal-day-name">${d}</div>`);

  for (let i = 0; i < firstDay; i++) html += `<div></div>`; // Bỏ trống các ô đầu tháng
  for (let i = 1; i <= daysInMonth; i++) {
    const isToday = i === now.getDate() ? 'today' : '';
    let dot = '';
    if (dayDist[i]) {
      // Độ đậm nhạt (opacity) phụ thuộc vào quãng đường so với ngày kỷ lục
      const opacity = Math.max(0.25, dayDist[i] / maxDist);
      dot = `<div class="cal-dot" style="opacity: ${opacity}"></div>`;
    }
    html += `<div class="cal-cell ${isToday}"><span>${i}</span>${dot}</div>`;
  }
  html += `</div></div>`;
  return html;
}

// Cập nhật lại hàm renderHist để hiển thị Lịch + Nút tải Sticker
async function renderHist() {
  const el = $('#hist');
  el.innerHTML = '<p class="text-zinc-500 text-center py-10 animate-pulse">Đang tải dữ liệu...</p>';
  const ws = await loadWorkouts();

  if (!ws.length) { el.innerHTML = '<p class="text-zinc-500 text-center py-10">' + t('empty') + '</p>'; return; }
  const tot = ws.reduce((a, w) => a + w.dist, 0);

  // Thêm Lịch lên đầu
  const calendarHtml = renderCalendar(ws);

  // Danh sách buổi tập
  const listHtml = `<div class="card p-3 text-sm text-zinc-400 flex justify-between items-center mb-4">
    <div>${ws.length} ${t('workouts')} · <b class="text-white">${tot.toFixed(1)} km</b> ${t('total')}</div>
    ${accessToken ? '<span class="text-xs text-lime-400 font-semibold">☁ Google Drive</span>' : '<span class="text-xs text-zinc-500">💾 Local Storage</span>'}
  </div>` + ws.map(w => `
  <div class="card p-3 flex gap-3 mb-3" style="--c:${COL[w.type]}">
    <canvas width="220" height="220" data-id="${w.id}" class="w-24 h-24 rounded-xl bg-black shrink-0"></canvas>
    <div class="flex-1 min-w-0">
      <div class="font-bold">${w.type === 'run' ? t('runS') : t('rideS')} <span class="text-xs text-zinc-500 font-normal">${new Date(w.date).toLocaleString(loc())}</span></div>
      <div class="text-sm mt-1" style="color:var(--c)">${w.dist.toFixed(2)} km · ${fmtT(w.dur)} · ${fmtPace(w.dist, w.dur, w.type)} ${w.type === 'run' ? '/km' : 'km/h'} · ${w.kcal} kcal</div>
      ${w.notes ? `<div class="text-xs text-zinc-400 mt-1 truncate">${w.notes.replace(/</g, '&lt;')}</div>` : ''}
      <div class="flex gap-2 mt-3 items-center flex-wrap">
        <button class="btn neon text-xs py-1" onclick="openShare(${w.id})">${t('shareBtn')}</button>
        <!-- Nút tải Sticker nền trong suốt -->
        <button class="btn border border-zinc-600 text-xs py-1 text-white" onclick="downloadSticker(${w.id})">⬇ Tải Sticker PNG</button>
        <button class="btn text-xs py-1 ml-auto" onclick="del(${w.id})">🗑</button>
      </div></div></div>`).join('');

  el.innerHTML = calendarHtml + listHtml;
  el.querySelectorAll('canvas').forEach(c => { const w = ws.find(x => x.id == c.dataset.id); drawRoute(c, w.pts, COL[w.type], 5); });
}

// ---------- Sticker nền trong suốt ----------
// Hàm vẽ canvas trên nền suốt và tải về
async function downloadSticker(id) {
  const ws = accessToken ? driveWorkoutsCache : loadLocal();
  const w = ws.find(x => x.id === id);
  if (!w) return;

  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 650;
  const ctx = canvas.getContext('2d');

  // Không vẽ màu nền -> Mặc định canvas sẽ là TRONG SUỐT
  ctx.clearRect(0, 0, 400, 650);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff'; // Chữ màu trắng
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; // Đổ bóng nhẹ để nổi bật trên ảnh sáng
  ctx.shadowBlur = 4;

  // Vẽ các Text giống ảnh mẫu
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('Distance', 200, 60);
  ctx.font = 'bold 55px sans-serif';
  ctx.fillText(w.dist.toFixed(2) + ' km', 200, 115);

  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(w.type === 'run' ? 'Pace' : 'Speed', 200, 190);
  ctx.font = 'bold 55px sans-serif';
  ctx.fillText(fmtPace(w.dist, w.dur, w.type) + (w.type === 'run' ? ' /km' : ' km/h'), 200, 245);

  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('Time', 200, 320);
  ctx.font = 'bold 55px sans-serif';
  const h = Math.floor(w.dur / 3600);
  const min = Math.floor((w.dur % 3600) / 60);
  const sec = Math.floor(w.dur % 60);
  ctx.fillText((h > 0 ? h + 'h ' : '') + min + 'm ' + sec + 's', 200, 375);

  // Vẽ route màu cam ở dưới cùng
  ctx.shadowBlur = 0; // Tắt shadow cho đường kẻ
  const pts = w.pts;
  if (pts && pts.length > 1) {
    const pad = 40, routeH = 180, routeY = 430;
    const la = pts.map(p => p[0]), lo = pts.map(p => p[1]), kx = Math.cos(la[0] * Math.PI / 180);
    const x0 = Math.min(...lo) * kx, x1 = Math.max(...lo) * kx, y0 = Math.min(...la), y1 = Math.max(...la);
    const s = Math.min((400 - 2 * pad) / ((x1 - x0) || 1e-5), routeH / ((y1 - y0) || 1e-5));
    const ox = (400 - (x1 - x0) * s) / 2, oy = (routeH - (y1 - y0) * s) / 2;
    const P = p => [ox + (p[1] * kx - x0) * s, routeY + routeH - (oy + (p[0] - y0) * s)];

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ff6600'; // Màu cam giống bản tham chiếu
    ctx.lineWidth = 8;
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }

  // Tải file tự động
  const a = document.createElement('a');
  a.download = `Sticker_BuoiTap_${new Date(w.date).getTime()}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

async function del(id) {
  if (confirm(t('delConf'))) {
    if (accessToken) {
      const w = driveWorkoutsCache.find(x => x.id === id);
      if (w) await deleteDriveWorkout(w);
    } else {
      saveLocal(loadLocal().filter(w => w.id !== id));
    }
    renderHist();
  }
}

// ---------- 16:9 Share card ----------
async function openShare(id) {
  window._sid = id;
  const ws = accessToken ? driveWorkoutsCache : loadLocal();
  const w = ws.find(x => x.id === id);
  if (!w) return;
  const c = COL[w.type], bg = w.endPhoto || w.startPhoto;
  const st = (l, v) => `<div style="background:#ffffff12;border-radius:14px;padding:12px 16px"><div style="font-size:30px;font-weight:900;color:${c}">${v}</div><div style="font-size:12px;letter-spacing:2px;color:#aab">${l}</div></div>`;
  
  $('#cardBox').innerHTML = `
  ${bg ? `<img src="${bg}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35">` : ''}
  <div style="position:absolute;inset:0;background:linear-gradient(120deg,#0a0a0fee 35%,#0a0a0f99)"></div>
  <div style="position:absolute;left:40px;top:40px;width:400px;height:400px;background:#00000066;border:1px solid ${c}55;border-radius:24px"><canvas id="cRoute" width="800" height="800" style="width:400px;height:400px"></canvas></div>
  ${w.startPhoto && w.endPhoto ? `<div style="position:absolute;left:40px;top:456px;display:flex;gap:10px"><img src="${w.startPhoto}" style="width:64px;height:64px;border-radius:12px;object-fit:cover;border:2px solid ${c}"><img src="${w.endPhoto}" style="width:64px;height:64px;border-radius:12px;object-fit:cover;border:2px solid #ff3355"></div>` : ''}
  <div style="position:absolute;left:480px;top:40px;right:40px">
    <div style="font-size:14px;letter-spacing:4px;color:${c};font-weight:800">${w.type === 'run' ? t('RUN') : t('CYC')}</div>
    <div style="font-size:26px;font-weight:800;margin:4px 0 16px">${new Date(w.date).toLocaleDateString(loc(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
      ${st(t('dist'), w.dist.toFixed(2))}${st(t('tm'), fmtT(w.dur))}${st(w.type === 'run' ? t('pace') : t('speed'), fmtPace(w.dist, w.dur, w.type))}</div>
    <div style="font-size:12px;letter-spacing:2px;color:#aab;margin:18px 0 6px">${w.type === 'run' ? t('cPace') : t('cSpeed')} · ${w.kcal} KCAL</div>
    <canvas id="cChart" width="880" height="240" style="width:440px;height:120px"></canvas>
    ${w.notes ? `<div style="font-size:14px;color:#ccd;margin-top:10px;max-height:40px;overflow:hidden">“${w.notes.replace(/</g, '&lt;').slice(0, 110)}”</div>` : ''}
  </div>
  <div style="position:absolute;right:40px;bottom:28px;font-weight:900;letter-spacing:3px;font-size:16px">MY FITNESS <span style="color:${c}">JOURNEY</span></div>`;
  
  $('#share').classList.remove('hidden');
  drawRoute($('#cRoute'), w.pts, c, 8); drawChart($('#cChart'), w, c);
  const k = Math.min(1, (innerWidth - 24) / 960), wr = $('#cardWrap');
  wr.style.transform = `scale(${k})`; wr.style.marginBottom = `-${540 * (1 - k)}px`;
}

$('#closeShare').onclick = () => $('#share').classList.add('hidden');
$('#dl').onclick = async () => {
  const b = $('#dl'); b.textContent = t('render');
  const cv = await html2canvas($('#cardBox'), { scale: 2, backgroundColor: '#0a0a0f', useCORS: true, onclone: d => { const x = d.getElementById('cardWrap'); x.style.transform = 'none'; x.style.marginBottom = '0'; } });
  const a = document.createElement('a'); a.download = 'my-fitness-journey.png'; a.href = cv.toDataURL('image/png'); a.click(); b.textContent = t('dl');
};