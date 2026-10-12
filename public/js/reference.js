'use strict';

(async () => {
  const { h, api, alertBox, showFieldErrors, clearErrorsOnEdit, formatDate, loadCompany } = window.App;
  const root = document.getElementById('reference');
  // The token lives in the URL fragment, which the browser never sends to the server.
  const token = location.hash.slice(1);

  await loadCompany();

  let info;
  try {
    if (!token) throw new Error('This reference link is incomplete. Please open the full link from your email.');
    info = await api('/api/references/lookup', { method: 'POST', body: { token } });
  } catch (error) {
    root.replaceChildren(alertBox('error', error.message));
    return;
  }

  let uid = 0;
  function field(label, control, { required = false, hint } = {}) {
    control.id = `r${++uid}`;
    return h(
      'div',
      { class: 'field' },
      h('label', { for: control.id, class: required ? 'req' : null }, label),
      control,
      hint && h('span', { class: 'hint' }, hint)
    );
  }
  const text = (name, attrs = {}) => h('textarea', { 'data-field': name, ...attrs });

  const confirm = h('input', { type: 'checkbox', 'data-field': 'confirm' });
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn' }, 'Submit reference');
  const reemploy = h(
    'div',
    { 'data-field': 'wouldReemploy', role: 'radiogroup', tabindex: '-1' },
    [['yes', 'Yes'], ['no', 'No'], ['not_applicable', 'Not applicable']].map(([value, label]) =>
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'reemploy', value }), label)
    )
  );

  const form = h(
    'form',
    { class: 'card', novalidate: true },
    field(`How do you know ${info.candidateName}?`, text('relationship', { maxlength: 300 }), { required: true, hint: 'For example: "I was their line manager at Acme Ltd."' }),
    field('How long have you known them?', h('input', { type: 'text', 'data-field': 'knownFor', maxlength: 100 }), { required: true }),
    field('What are their main strengths?', text('strengths', { maxlength: 3000 }), { required: true }),
    field('Are there areas where they could develop?', text('development', { maxlength: 3000 })),
    h('div', { class: 'field' }, h('span', { class: 'label req' }, 'Would you work with or employ them again?'), reemploy),
    field('Anything else you would like to add?', text('comments', { maxlength: 5000 })),
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { class: 'choice' },
        confirm,
        `I confirm this reference is accurate to the best of my knowledge and may be shared with ${info.companyName}'s hiring team.`
      )
    ),
    status,
    submit
  );

  clearErrorsOnEdit(form);
  const value = (name) => form.querySelector(`[data-field="${name}"]`).value.trim();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.replaceChildren();
    const checked = form.querySelector('input[name="reemploy"]:checked');
    submit.disabled = true;
    try {
      await api('/api/references/submit', {
        method: 'POST',
        body: {
          token,
          relationship: value('relationship'),
          knownFor: value('knownFor'),
          strengths: value('strengths'),
          development: value('development'),
          wouldReemploy: checked ? checked.value : '',
          comments: value('comments'),
          confirm: confirm.checked,
        },
      });
      root.replaceChildren(
        h('div', { class: 'card' }, h('h1', null, 'Thank you'), h('p', null, `Your reference for ${info.candidateName} has been sent securely to ${info.companyName}. You can close this page.`))
      );
    } catch (error) {
      showFieldErrors(form, error.fields);
      status.replaceChildren(alertBox('error', error.message));
      submit.disabled = false;
    }
  });

  root.replaceChildren(
    h('h1', null, `Reference for ${info.candidateName}`),
    h(
      'p',
      { class: 'lead' },
      `${info.refereeName ? `Dear ${info.refereeName}, ` : ''}${info.candidateName} has applied for the role of ${info.jobTitle} at ${info.companyName} and named you as a referee.`
    ),
    h('p', { class: 'muted small' }, `This private link can be used once and expires on ${formatDate(info.expiresAt)}. Your answers are encrypted and seen only by the hiring team.`),
    form
  );
})();
