'use strict';

(async () => {
  const { h, api, alertBox, showFieldErrors, clearErrorsOnEdit, loadCompany } = window.App;
  const root = document.getElementById('setup');
  loadCompany();

  let status;
  try {
    status = await api('/api/setup/status');
  } catch (error) {
    root.replaceChildren(alertBox('error', error.message));
    return;
  }

  if (status.state === 'done') {
    root.replaceChildren(
      h('div', { class: 'card login-card' }, h('h1', null, 'Setup is complete'), h('p', null, 'An admin account already exists.'), h('a', { class: 'btn', href: '/admin' }, 'Go to sign in'))
    );
    return;
  }
  if (status.state === 'disabled') {
    root.replaceChildren(
      h(
        'div',
        { class: 'card login-card' },
        h('h1', null, 'Browser setup is off'),
        h('p', null, 'To create the first admin account here, add a SETUP_CODE setting (a long random value) in your hosting dashboard, restart the app and reload this page.')
      )
    );
    return;
  }

  const field = (id, label, control, hint) => {
    control.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint && h('span', { class: 'hint' }, hint));
  };

  // ---- Step 1: setup code, username, password ------------------------------

  const setupCode = h('input', { type: 'password', autocomplete: 'off', 'data-field': 'setupCode', spellcheck: 'false' });
  const username = h('input', { type: 'text', autocomplete: 'username', maxlength: 64, 'data-field': 'username' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 256, 'data-field': 'password' });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 256, 'data-field': 'repeat' });
  const status1 = h('div', { 'aria-live': 'polite' });
  const next = h('button', { type: 'submit', class: 'btn' }, 'Next');

  const step1 = h(
    'form',
    { class: 'card login-card', novalidate: true },
    h('h1', null, 'Create your admin account'),
    h('p', { class: 'muted small' }, 'This page works only once: after the first account is created it switches itself off.'),
    field('setup-code', 'Setup code', setupCode, 'Copy the SETUP_CODE value from your hosting dashboard.'),
    field('username', 'Choose a username', username),
    field('password', 'Choose a password', password, 'At least 12 characters. A few random words work well, e.g. "lamp river orange pocket".'),
    field('repeat', 'Repeat the password', repeat),
    status1,
    next
  );
  clearErrorsOnEdit(step1);

  step1.addEventListener('submit', async (event) => {
    event.preventDefault();
    status1.replaceChildren();
    if (password.value !== repeat.value) {
      showFieldErrors(step1, { repeat: 'The passwords do not match.' });
      return;
    }
    next.disabled = true;
    try {
      const account = { setupCode: setupCode.value.trim(), username: username.value.trim(), password: password.value };
      const result = await api('/api/setup/start', { method: 'POST', body: account });
      showStep2(account, result);
    } catch (error) {
      showFieldErrors(step1, error.fields);
      status1.replaceChildren(alertBox('error', error.message));
      next.disabled = false;
    }
  });

  // ---- Step 2: authenticator app ---------------------------------------------

  function showStep2(account, { totpSecret, qrCode }) {
    const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, 'data-field': 'code' });
    const status2 = h('div', { 'aria-live': 'polite' });
    const finish = h('button', { type: 'submit', class: 'btn' }, 'Finish setup');
    const step2 = h(
      'form',
      { class: 'card login-card', novalidate: true },
      h('h1', null, 'Connect your phone'),
      h(
        'ol',
        null,
        h('li', null, 'Install an authenticator app on your phone if you don’t have one (Google Authenticator, Microsoft Authenticator or similar).'),
        h('li', null, 'In the app, tap ', h('strong', null, '+'), ' (add account) and scan this code:')
      ),
      h('p', null, h('img', { src: qrCode, alt: 'QR code for your authenticator app', width: 220, height: 220 })),
      h('p', { class: 'muted small' }, 'Can’t scan it? Choose “enter a setup key” in the app and type: ', h('strong', null, totpSecret.match(/.{1,4}/g).join(' '))),
      field('code', 'Enter the 6-digit code the app now shows', code),
      status2,
      finish
    );
    clearErrorsOnEdit(step2);

    step2.addEventListener('submit', async (event) => {
      event.preventDefault();
      status2.replaceChildren();
      finish.disabled = true;
      try {
        await api('/api/setup/complete', { method: 'POST', body: { ...account, totpSecret, code: code.value.trim() } });
        root.replaceChildren(
          h(
            'div',
            { class: 'card login-card' },
            h('h1', null, 'All set'),
            h('p', null, 'Your admin account is ready and you are signed in. From now on, sign in with your username, password and the code from your phone.'),
            h('p', { class: 'muted small' }, 'Keep your phone safe: you need it to sign in. This setup page is now switched off.'),
            h('a', { class: 'btn', href: '/admin' }, 'Open the dashboard')
          )
        );
      } catch (error) {
        showFieldErrors(step2, error.fields);
        status2.replaceChildren(alertBox('error', error.message));
        finish.disabled = false;
        code.value = '';
      }
    });

    root.replaceChildren(step2);
    code.focus();
  }

  root.replaceChildren(step1);
  setupCode.focus();
})();
