// App shell: sign-in, role-based navigation and a tiny hash router. Page code is loaded per role (code splitting).
// NOTE: hiding menu items is only a convenience. The backend enforces every permission.
import { api } from './api.js';
import { h, clear, toast, buildForm, formModal, skeleton, errorState } from './ui.js';

const root = document.getElementById('root');
const LOADERS = {
  Admin: () => import('./pages/admin.js'),
  Receptionist: () => import('./pages/receptionist.js'),
  Doctor: () => import('./pages/doctor.js'),
  Pharmacist: () => import('./pages/pharmacist.js'),
  Patient: () => import('./pages/patient.js'),
};

let user = null;
let renderSeq = 0;
let shell = null;
let onHash = null;

// ------------------------------------------------------------------ sign-in
function showLogin(message) {
  if (onHash) window.removeEventListener('hashchange', onHash);
  onHash = null;
  shell = null;
  user = null;
  document.title = 'Sign in · Hospital Management System';

  const { form, setError } = buildForm({
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true, full: true },
      { name: 'password', label: 'Password', type: 'password', required: true, full: true },
    ],
    submitLabel: 'Sign in',
    onSubmit: async (values) => {
      const res = await api.post('/auth/login', values);
      user = res.user;
      await showApp();
    },
  });
  form.querySelector('input[name=email]').autocomplete = 'username';
  form.querySelector('input[name=password]').autocomplete = 'current-password';
  form.style.gridTemplateColumns = '1fr';
  if (message) setError(message);

  clear(root).append(
    h(
      'div',
      { class: 'login-wrap' },
      h(
        'section',
        { class: 'login-brand' },
        h('h1', {}, 'Hospital Management System'),
        h('p', {}, 'Appointments, prescriptions and pharmacy in one place, with access controlled by role.'),
        h('div', { class: 'notice' }, 'Educational portfolio project. All patients, doctors and medications are fictional. Not a certified clinical system.')
      ),
      h('main', { class: 'login-panel' }, h('div', { class: 'login-card' }, h('h2', {}, 'Sign in'), form))
    )
  );
  form.querySelector('input[name=email]').focus();
}

// ------------------------------------------------------------------ shell
async function showApp() {
  const mod = await LOADERS[user.role]();
  const pages = mod.pages;
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, pages.map((p) => h('a', { href: `#/${p.id}`, dataset: { id: p.id } }, p.label)));
  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h('div', { class: 'sidebar-top' }, h('div', { class: 'brand' }, 'HMS', h('small', {}, `${user.role} portal`)), h('button', { class: 'btn sm menu-toggle', type: 'button', 'aria-label': 'Toggle menu', onclick: () => sidebar.classList.toggle('open') }, 'Menu')),
    nav,
    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', { class: 'who' }, h('strong', {}, user.fullName), user.email),
      h('button', { class: 'btn sm', type: 'button', onclick: openPasswordModal }, 'Change password'),
      h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Sign out')
    )
  );
  shell = { main, nav, sidebar, pages };
  clear(root).append(h('div', { class: 'app' }, sidebar, main));

  onHash = () => render();
  window.addEventListener('hashchange', onHash);
  render();
}

async function render() {
  if (!shell) return;
  const mine = ++renderSeq;
  const id = location.hash.replace(/^#\//, '');
  const page = shell.pages.find((p) => p.id === id) || shell.pages[0];
  for (const a of shell.nav.querySelectorAll('a')) {
    if (a.dataset.id === page.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    a.classList.toggle('active', a.dataset.id === page.id);
  }
  shell.sidebar.classList.remove('open');
  document.title = `${page.label} · Hospital Management System`;
  clear(shell.main).append(skeleton(6));
  try {
    const container = h('div');
    await page.render(container, { user });
    if (mine !== renderSeq) return;
    clear(shell.main).append(container);
  } catch (err) {
    if (mine !== renderSeq) return;
    clear(shell.main).append(errorState(err, render));
  }
}

async function logout() {
  try {
    await api.post('/auth/logout');
  } catch (err) {
    /* signing out locally anyway */
  }
  location.hash = '';
  showLogin();
}

function openPasswordModal() {
  formModal({
    title: 'Change password',
    submitLabel: 'Update password',
    fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', required: true, full: true },
      { name: 'newPassword', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 10 characters with an uppercase letter, a lowercase letter and a digit.' },
    ],
    onSubmit: async (values) => {
      await api.post('/auth/change-password', values);
      toast('Password updated');
    },
  });
}

window.addEventListener('auth:expired', () => {
  if (user) showLogin('Your session has expired. Please sign in again.');
});

(async function boot() {
  try {
    const res = await api.get('/auth/me');
    user = res.user;
    await showApp();
  } catch (err) {
    showLogin();
  }
})();
