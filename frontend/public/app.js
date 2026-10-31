const $ = id => document.getElementById(id);
let token = localStorage.getItem('token');
let picked = [];
let current = null;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function msg(text, ok) {
  $('msg').textContent = text;
  $('msg').className = ok ? 'ok' : 'err';
}

function show(view) {
  ['events', 'seats', 'auth', 'mine'].forEach(v => { $(v).hidden = v !== view; });
  if (view === 'events') loadEvents();
  if (view === 'mine') loadBookings();
}

function refreshUser() {
  $('user').textContent = token ? localStorage.getItem('name') : '';
  $('loginBtn').hidden = !!token;
  $('logoutBtn').hidden = !token;
  $('mineBtn').hidden = !token;
}

async function loadEvents() {
  try {
    const events = await api('/events');
    $('eventList').innerHTML = events.map(e => `
      <div class="card">
        <h3>${e.title}</h3>
        <p>${e.venue}</p>
        <p>${new Date(e.starts_at).toLocaleString()}</p>
        <p><b>Rs ${e.price}</b> per seat, ${e.available} left</p>
        <button onclick="openEvent(${e.id})">Select seats</button>
      </div>`).join('');
  } catch (e) { msg(e.message, false); }
}

async function openEvent(id) {
  current = id;
  picked = [];
  $('selected').textContent = 'none';
  const seats = await api(`/events/${id}/seats`);
  $('seatGrid').innerHTML = seats.map(s =>
    `<button class="seat ${s.status}" data-l="${s.label}" ${s.status !== 'available' ? 'disabled' : ''}>${s.label}</button>`).join('');
  document.querySelectorAll('.seat').forEach(b => { b.onclick = () => toggle(b); });
  show('seats');
}

function toggle(b) {
  const l = b.dataset.l;
  picked = picked.includes(l) ? picked.filter(x => x !== l) : [...picked, l];
  b.classList.toggle('picked');
  $('selected').textContent = picked.length ? picked.join(', ') : 'none';
}

async function book() {
  if (!token) { msg('Please log in to book', false); return show('auth'); }
  if (!picked.length) return msg('Pick at least one seat', false);
  try {
    const r = await api('/bookings', { method: 'POST', body: JSON.stringify({ eventId: current, seats: picked }) });
    msg(`Booked! Booking #${r.id}, total Rs ${r.total}`, true);
    show('mine');
  } catch (e) {
    msg(e.message, false);
    openEvent(current);
  }
}

async function loadBookings() {
  if (!token) return show('auth');
  const rows = await api('/bookings');
  $('bookingList').innerHTML = rows.length ? rows.map(b => `
    <div class="card">
      <h3>${b.title}</h3>
      <p>Seats: ${b.seats.join(', ')}</p>
      <p>Total: Rs ${b.total}</p>
      <p>Booked on ${new Date(b.created_at).toLocaleString()}</p>
    </div>`).join('') : '<p>No bookings yet.</p>';
}

async function authenticate(kind) {
  try {
    const body = { email: $('email').value, password: $('password').value };
    if (kind === 'register') body.name = $('name').value;
    const r = await api('/auth/' + kind, { method: 'POST', body: JSON.stringify(body) });
    token = r.token;
    localStorage.setItem('token', token);
    localStorage.setItem('name', r.name);
    refreshUser();
    msg('Welcome, ' + r.name, true);
    show('events');
  } catch (e) { msg(e.message, false); }
}

function logout() {
  token = null;
  localStorage.clear();
  refreshUser();
  show('events');
}

refreshUser();
show('events');
