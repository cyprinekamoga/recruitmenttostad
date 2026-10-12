'use strict';

(async () => {
  const { h, api, alertBox, showFieldErrors, clearErrorsOnEdit, loadCompany } = window.App;
  const root = document.getElementById('job');
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const MAX_REFEREES = 5;

  const config = await loadCompany();
  let job;
  try {
    ({ job } = await api(`/api/jobs/${encodeURIComponent(slug)}`));
  } catch (error) {
    root.replaceChildren(
      alertBox('error', error.status === 404 ? 'This position is no longer open.' : error.message),
      h('p', null, h('a', { href: '/' }, 'See all open positions'))
    );
    return;
  }
  document.title = `${job.title} – ${config.companyName || 'Careers'}`;

  // ---- form building helpers ----------------------------------------------

  let uid = 0;
  function field(label, input, { required = false, hint } = {}) {
    const id = input.id || `f${++uid}`;
    input.id = id;
    if (required) input.required = true;
    const hintEl = hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null;
    if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
    return h('div', { class: 'field' }, h('label', { for: id, class: required ? 'req' : null }, label), input, hintEl);
  }
  const input = (name, attrs = {}) => h('input', { type: 'text', 'data-field': name, ...attrs });

  function questionField(question) {
    const name = `answers.${question.id}`;
    if (question.type === 'short_text') return field(question.label, input(name, { maxlength: 300 }), { required: question.required });
    if (question.type === 'long_text') {
      return field(question.label, h('textarea', { 'data-field': name, maxlength: 5000 }), { required: question.required });
    }
    const options = question.type === 'yes_no' ? [['yes', 'Yes'], ['no', 'No']] : question.options.map((o) => [o, o]);
    const group = h(
      'div',
      { role: 'radiogroup', 'data-field': name, tabindex: '-1' },
      options.map(([value, label]) =>
        h('label', { class: 'choice' }, h('input', { type: 'radio', name: `q-${question.id}`, value, required: question.required }), label)
      )
    );
    const groupLabelId = `f${++uid}`;
    group.setAttribute('aria-labelledby', groupLabelId);
    return h('div', { class: 'field' }, h('span', { class: `label${question.required ? ' req' : ''}`, id: groupLabelId }, question.label), group);
  }

  const refereeList = h('div');
  const addRefereeButton = h('button', { type: 'button', class: 'btn secondary small', onclick: () => addReferee() }, '+ Add a referee');

  function renumberReferees() {
    [...refereeList.children].forEach((block, index) => {
      block.querySelector('h3').textContent = `Referee ${index + 1}`;
      block.querySelectorAll('[data-key]').forEach((el) => el.setAttribute('data-field', `references.${index}.${el.dataset.key}`));
      const remove = block.querySelector('.remove');
      remove.hidden = refereeList.children.length <= job.referencesRequired;
    });
    addRefereeButton.hidden = refereeList.children.length >= MAX_REFEREES;
  }

  function addReferee() {
    const ref = (key, attrs = {}) => h('input', { type: 'text', 'data-key': key, ...attrs });
    const block = h(
      'div',
      { class: 'referee' },
      h(
        'div',
        { class: 'referee-head' },
        h('h3', null, 'Referee'),
        h('button', { type: 'button', class: 'btn danger small remove', onclick: () => { block.remove(); renumberReferees(); } }, 'Remove')
      ),
      h(
        'div',
        { class: 'grid-2' },
        field('Full name', ref('name', { maxlength: 120, autocomplete: 'off' }), { required: true }),
        field('Relationship to you', ref('relationship', { maxlength: 120, placeholder: 'e.g. Former manager' }), { required: true }),
        field('Organisation', ref('organisation', { maxlength: 120 })),
        field('Email', ref('email', { type: 'email', maxlength: 254, autocomplete: 'off' }), { required: true }),
        field('Phone', ref('phone', { type: 'tel', maxlength: 40, autocomplete: 'off' }))
      )
    );
    refereeList.append(block);
    renumberReferees();
  }

  // ---- the form -------------------------------------------------------------

  const maxMb = config.maxUploadMb || 5;
  const fileHint = `PDF or Word (.docx), up to ${maxMb} MB.`;
  const cvInput = h('input', { type: 'file', name: 'cv', accept: '.pdf,.docx', 'data-field': 'cv' });
  const coverInput = h('input', { type: 'file', name: 'coverLetter', accept: '.pdf,.docx', 'data-field': 'coverLetter' });
  const consentInput = h('input', { type: 'checkbox', 'data-field': 'consent', required: true });
  const honeypot = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn' }, 'Submit application');

  const retention = config.retentionDays
    ? `We keep applications for ${config.retentionDays} days after our last activity on them, then delete them automatically.`
    : 'We keep applications only as long as needed for recruitment.';
  const contact = config.privacyContactEmail
    ? [' To see, correct or delete your data, email ', h('a', { href: `mailto:${config.privacyContactEmail}` }, config.privacyContactEmail), '.']
    : [];

  const form = h(
    'form',
    { class: 'card', novalidate: true },
    h(
      'fieldset',
      null,
      h('legend', null, 'About you'),
      h(
        'div',
        { class: 'grid-2' },
        field('Full name', input('fullName', { autocomplete: 'name', maxlength: 120 }), { required: true }),
        field('Email', input('email', { type: 'email', autocomplete: 'email', maxlength: 254 }), { required: true }),
        field('Phone', input('phone', { type: 'tel', autocomplete: 'tel', maxlength: 40 })),
        field('Where are you based?', input('location', { autocomplete: 'address-level2', maxlength: 120 }))
      ),
      field('LinkedIn or portfolio link', input('profileUrl', { type: 'url', maxlength: 300, placeholder: 'https://' }))
    ),
    job.questions.length > 0 && h('fieldset', null, h('legend', null, 'Questions'), job.questions.map(questionField)),
    h(
      'fieldset',
      null,
      h('legend', null, 'Documents'),
      field('CV / résumé', cvInput, { required: true, hint: fileHint }),
      field('Cover letter (optional)', coverInput, { hint: fileHint })
    ),
    h(
      'fieldset',
      null,
      h('legend', null, 'References'),
      h(
        'p',
        { class: 'muted small', 'data-field': 'references', tabindex: '-1' },
        job.referencesRequired > 0
          ? `Please give at least ${job.referencesRequired} referee(s). We will only contact them if you progress, and they will see only your name and the role.`
          : 'Optional. We will only contact referees if you progress, and they will see only your name and the role.'
      ),
      refereeList,
      addRefereeButton
    ),
    h(
      'fieldset',
      null,
      h('legend', null, 'Privacy'),
      h(
        'div',
        { class: 'privacy' },
        `${config.companyName || 'We'} will use the information you provide only to assess your application for this role. It is encrypted and visible only to our hiring team. `,
        retention,
        contact
      ),
      h('div', { class: 'field' }, h('label', { class: 'choice' }, consentInput, 'I agree to my information being processed as described above.'))
    ),
    h('div', { class: 'hp', 'aria-hidden': 'true' }, h('label', null, 'Website', honeypot)),
    status,
    h('div', { class: 'btn-row' }, submit)
  );

  clearErrorsOnEdit(form);
  for (let i = 0; i < job.referencesRequired; i++) addReferee();
  renumberReferees();

  function value(name) {
    const el = form.querySelector(`[data-field="${name}"]`);
    return el ? el.value.trim() : '';
  }

  function collect() {
    const answers = {};
    for (const question of job.questions) {
      if (question.type === 'short_text' || question.type === 'long_text') {
        answers[question.id] = value(`answers.${question.id}`);
      } else {
        const checked = form.querySelector(`input[name="q-${CSS.escape(question.id)}"]:checked`);
        answers[question.id] = checked ? checked.value : '';
      }
    }
    const references = [...refereeList.children].map((block) => {
      const get = (key) => block.querySelector(`[data-key="${key}"]`).value.trim();
      return { name: get('name'), relationship: get('relationship'), organisation: get('organisation'), email: get('email'), phone: get('phone') };
    });
    return {
      fullName: value('fullName'),
      email: value('email'),
      phone: value('phone'),
      location: value('location'),
      profileUrl: value('profileUrl'),
      answers,
      references,
      consent: consentInput.checked,
      website: honeypot.value,
    };
  }

  function checkFile(inputEl, required) {
    const file = inputEl.files[0];
    if (!file) return required ? 'Please attach your CV.' : null;
    if (!/\.(pdf|docx)$/i.test(file.name)) return 'Please upload a PDF or Word (.docx) file.';
    if (file.size > maxMb * 1024 * 1024) return `This file is larger than ${maxMb} MB.`;
    return null;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.replaceChildren();
    const clientErrors = {};
    const cvProblem = checkFile(cvInput, true);
    const coverProblem = checkFile(coverInput, false);
    if (cvProblem) clientErrors.cv = cvProblem;
    if (coverProblem) clientErrors.coverLetter = coverProblem;
    if (!consentInput.checked) clientErrors.consent = 'You must agree to the privacy notice to apply.';
    if (Object.keys(clientErrors).length) {
      showFieldErrors(form, clientErrors);
      status.replaceChildren(alertBox('error', 'Please fix the highlighted fields.'));
      return;
    }

    const data = new FormData();
    data.append('application', JSON.stringify(collect()));
    data.append('cv', cvInput.files[0]);
    if (coverInput.files[0]) data.append('coverLetter', coverInput.files[0]);

    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(job.slug)}/apply`, { method: 'POST', form: data });
      root.replaceChildren(
        h(
          'div',
          { class: 'card' },
          h('h1', null, 'Application received'),
          h('p', null, `Thank you for applying for ${job.title}. Your reference is `, h('strong', null, result.reference), '.'),
          h('p', { class: 'muted' }, 'We will be in touch if your application progresses.'),
          h('a', { href: '/' }, 'Back to all positions')
        )
      );
      window.scrollTo(0, 0);
    } catch (error) {
      showFieldErrors(form, error.fields);
      status.replaceChildren(alertBox('error', error.message));
      submit.disabled = false;
      submit.textContent = 'Submit application';
    }
  });

  root.replaceChildren(
    h('h1', null, job.title),
    h('div', { class: 'tags' }, job.location && h('span', { class: 'tag' }, job.location), job.employmentType && h('span', { class: 'tag' }, job.employmentType)),
    h('div', { class: 'card pre' }, job.description),
    h('h2', null, 'Apply for this role'),
    h('p', { class: 'muted small' }, 'Fields marked * are required.'),
    form
  );
})();
