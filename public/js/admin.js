'use strict';

(() => {
  const { h, api, alertBox, showFieldErrors, formatDate, formatSize, safeUrl, loadCompany } = window.App;
  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const state = { me: null, csrf: null };

  const STATUS_LABELS = {
    new: 'New',
    reviewing: 'Reviewing',
    shortlisted: 'Shortlisted',
    interview: 'Interview',
    offer: 'Offer made',
    hired: 'Hired',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
  };
  const QUESTION_TYPES = { short_text: 'Short answer', long_text: 'Long answer', yes_no: 'Yes / No', single_choice: 'Multiple choice' };
  const statusBadge = (status) => h('span', { class: `status ${status}` }, STATUS_LABELS[status] || status);

  /** API call with the CSRF token; an expired session sends the user back to sign-in. */
  async function call(path, options = {}) {
    try {
      return await api(path, { ...options, csrf: state.csrf });
    } catch (error) {
      if (error.status === 401 && state.me) {
        state.me = null;
        showLogin('Your session has ended. Please sign in again.');
      }
      throw error;
    }
  }

  function render(...children) {
    view.replaceChildren(...children);
    window.scrollTo(0, 0);
  }

  function fail(error) {
    if (error.status !== 401) render(alertBox('error', error.message));
  }

  // ---- Sign-in ---------------------------------------------------------------

  function showLogin(message) {
    nav.hidden = true;
    const status = h('div', { 'aria-live': 'polite' }, message && alertBox('info', message));
    const username = h('input', { type: 'text', id: 'username', autocomplete: 'username', required: true });
    const password = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const code = h('input', { type: 'text', id: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6 });
    const button = h('button', { type: 'submit', class: 'btn' }, 'Sign in');
    const form = h(
      'form',
      { class: 'card login-card' },
      h('h1', null, 'Sign in'),
      status,
      h('div', { class: 'field' }, h('label', { for: 'username' }, 'Username'), username),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), password),
      h('div', { class: 'field' }, h('label', { for: 'code' }, 'Authenticator code'), code, h('span', { class: 'hint' }, '6-digit code from your authenticator app.')),
      button
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await api('/api/admin/login', { method: 'POST', body: { username: username.value, password: password.value, code: code.value } });
        password.value = '';
        await start();
      } catch (error) {
        status.replaceChildren(alertBox('error', error.message));
        code.value = '';
        button.disabled = false;
      }
    });
    render(form);
    username.focus();
    api('/api/setup/status')
      .then(({ state }) => {
        if (state === 'ready') status.replaceChildren(alertBox('info', 'No admin account exists yet.'), h('p', null, h('a', { class: 'btn', href: '/setup' }, 'Run first-time setup')));
      })
      .catch(() => {});
  }

  // ---- Routing ---------------------------------------------------------------

  function go(hash) {
    if (location.hash === `#${hash}`) route();
    else location.hash = hash;
  }

  async function route() {
    if (!state.me) return;
    const [name, arg] = location.hash.slice(1).split('/');
    nav.querySelectorAll('[data-route]').forEach((button) => {
      const active = button.dataset.route === name || (name === 'application' && button.dataset.route === 'applications') || (name === 'job' && button.dataset.route === 'jobs');
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    try {
      if (name === 'application' && arg) await showApplication(arg);
      else if (name === 'jobs') await showJobs();
      else if (name === 'job') await showJobEditor(arg);
      else if (name === 'activity') await showActivity();
      else if (name === 'account') showAccount();
      else await showApplications();
    } catch (error) {
      fail(error);
    }
  }

  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-route]');
    if (button) go(button.dataset.route);
  });
  document.getElementById('logout').addEventListener('click', async () => {
    try {
      await call('/api/admin/logout', { method: 'POST' });
    } finally {
      state.me = null;
      state.csrf = null;
      history.replaceState(null, '', location.pathname);
      showLogin('You have been signed out.');
    }
  });
  window.addEventListener('hashchange', route);

  // ---- Applications list -----------------------------------------------------

  const filters = { jobId: '', status: '' };

  async function showApplications() {
    const [{ jobs }, { applications }] = await Promise.all([
      call('/api/admin/jobs'),
      call(`/api/admin/applications?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v))}`),
    ]);

    const jobSelect = h('select', { id: 'filter-job' }, h('option', { value: '' }, 'All jobs'), jobs.map((job) => h('option', { value: job.id }, job.title)));
    jobSelect.value = filters.jobId;
    const statusSelect = h('select', { id: 'filter-status' }, h('option', { value: '' }, 'Any status'), state.me.statuses.map((s) => h('option', { value: s }, STATUS_LABELS[s] || s)));
    statusSelect.value = filters.status;
    const onFilter = () => {
      filters.jobId = jobSelect.value;
      filters.status = statusSelect.value;
      showApplications().catch(fail);
    };
    jobSelect.addEventListener('change', onFilter);
    statusSelect.addEventListener('change', onFilter);

    const rows = applications.map((app) => {
      const row = h(
        'tr',
        { class: 'clickable', tabindex: '0' },
        h('td', null, h('strong', null, app.fullName), h('div', { class: 'muted small' }, app.email)),
        h('td', null, app.jobTitle),
        h('td', null, statusBadge(app.status)),
        h('td', null, formatDate(app.createdAt)),
        h(
          'td',
          { class: 'small muted' },
          app.ref,
          app.otherApplications > 0 && h('div', null, `Applied ${app.otherApplications} other time(s)`),
          app.referencesReceived > 0 && h('div', null, `${app.referencesReceived} reference(s) received`)
        )
      );
      const open = () => go(`application/${app.id}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open();
      });
      return row;
    });

    render(
      h('h1', null, 'Applications'),
      h(
        'div',
        { class: 'toolbar' },
        h('div', { class: 'field' }, h('label', { for: 'filter-job' }, 'Job'), jobSelect),
        h('div', { class: 'field' }, h('label', { for: 'filter-status' }, 'Status'), statusSelect)
      ),
      applications.length === 0
        ? h('div', { class: 'card muted' }, jobs.length === 0 ? 'No jobs yet. Create one under "Jobs" to start receiving applications.' : 'No applications match these filters.')
        : h(
            'div',
            { class: 'table-wrap card' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, ['Applicant', 'Job', 'Status', 'Received', 'Ref'].map((t) => h('th', null, t)))),
              h('tbody', null, rows)
            )
          ),
      state.me.retentionDays > 0 && h('p', { class: 'muted small' }, `Applications are deleted automatically ${state.me.retentionDays} days after their last update.`)
    );
  }

  // ---- Application detail ----------------------------------------------------

  async function showApplication(id) {
    const { application: app } = await call(`/api/admin/applications/${encodeURIComponent(id)}`);
    const profile = safeUrl(app.profileUrl);

    const details = h(
      'dl',
      { class: 'details' },
      h('dt', null, 'Email'), h('dd', null, app.email),
      h('dt', null, 'Phone'), h('dd', null, app.phone || '—'),
      h('dt', null, 'Location'), h('dd', null, app.location || '—'),
      h('dt', null, 'Profile'), h('dd', null, profile ? h('a', { href: profile, target: '_blank', rel: 'noopener noreferrer' }, app.profileUrl) : '—'),
      h('dt', null, 'Applied'), h('dd', null, formatDate(app.createdAt, true)),
      h('dt', null, 'Reference'), h('dd', null, app.ref)
    );

    const answers = app.answers.length
      ? app.answers.map((qa) =>
          h('div', { class: 'qa' }, h('div', { class: 'q' }, qa.label), h('div', { class: 'pre' }, qa.type === 'yes_no' ? (qa.answer === 'yes' ? 'Yes' : qa.answer === 'no' ? 'No' : '—') : qa.answer || '—'))
        )
      : h('p', { class: 'muted' }, 'This job had no extra questions.');

    const referees = app.references.length
      ? app.references.map((referee, index) => refereeCard(app, referee, index))
      : h('p', { class: 'muted' }, 'No referees were given.');

    const headerBadge = h('span', null, statusBadge(app.status));

    // Side panel: status, notes, documents, history, delete.
    const statusSelect = h('select', { id: 'status' }, state.me.statuses.map((s) => h('option', { value: s }, STATUS_LABELS[s] || s)));
    statusSelect.value = app.status;
    const notes = h('textarea', { id: 'notes', maxlength: 10000, value: app.notes });
    const saveStatus = h('div', { 'aria-live': 'polite' });
    const saveButton = h('button', { type: 'button', class: 'btn' }, 'Save');
    saveButton.addEventListener('click', async () => {
      saveButton.disabled = true;
      try {
        await call(`/api/admin/applications/${app.id}`, { method: 'PATCH', body: { status: statusSelect.value, notes: notes.value } });
        headerBadge.replaceChildren(statusBadge(statusSelect.value));
        saveStatus.replaceChildren(alertBox('success', 'Saved.'));
      } catch (error) {
        saveStatus.replaceChildren(alertBox('error', error.message));
      } finally {
        saveButton.disabled = false;
      }
    });

    const deleteButton = h('button', { type: 'button', class: 'btn danger' }, 'Delete application permanently');
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`Permanently delete ${app.fullName}'s application, CV and references? This cannot be undone.`)) return;
      try {
        await call(`/api/admin/applications/${app.id}`, { method: 'DELETE' });
        go('applications');
      } catch (error) {
        saveStatus.replaceChildren(alertBox('error', error.message));
      }
    });

    const documents = app.files.map((file) =>
      h(
        'li',
        null,
        h('a', { href: `/api/admin/files/${file.id}`, download: file.name }, file.name),
        h('span', { class: 'muted small' }, ` · ${file.kind === 'cv' ? 'CV' : 'Cover letter'} · ${formatSize(file.size)}`)
      )
    );

    render(
      h('p', null, h('a', { href: '#applications' }, '← All applications')),
      h('h1', null, app.fullName),
      h('p', { class: 'muted' }, `${app.jobTitle} · `, headerBadge),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          null,
          h('div', { class: 'card' }, h('h2', null, 'Contact details'), details),
          h('div', { class: 'card' }, h('h2', null, 'Answers'), answers),
          h('div', { class: 'card' }, h('h2', null, 'References'), referees)
        ),
        h(
          'div',
          null,
          h(
            'div',
            { class: 'card' },
            h('h2', null, 'Progress'),
            h('div', { class: 'field' }, h('label', { for: 'status' }, 'Status'), statusSelect),
            h('div', { class: 'field' }, h('label', { for: 'notes' }, 'Private notes'), notes, h('span', { class: 'hint' }, 'Stored encrypted. Visible to admins only.')),
            saveStatus,
            saveButton
          ),
          h(
            'div',
            { class: 'card' },
            h('h2', null, 'Documents'),
            h('ul', null, documents),
            h('p', { class: 'muted small' }, 'Files are checked on upload, but only open documents from people you expect.')
          ),
          app.otherApplications.length > 0 &&
            h(
              'div',
              { class: 'card' },
              h('h2', null, 'Other applications'),
              h('ul', null, app.otherApplications.map((other) => h('li', null, h('a', { href: `#application/${other.id}` }, other.jobTitle), ` · ${formatDate(other.createdAt)} · `, statusBadge(other.status))))
            ),
          h('div', { class: 'card' }, h('h2', null, 'Delete'), h('p', { class: 'muted small' }, 'Removes all of this applicant’s data, including files and references.'), deleteButton)
        )
      )
    );
  }

  function refereeCard(app, referee, index) {
    const requests = app.referenceRequests.filter((r) => r.refereeIndex === index);
    const latest = requests[requests.length - 1];
    const output = h('div', { 'aria-live': 'polite' });

    async function createLink(sendEmail) {
      if (latest && latest.status === 'pending' && !confirm('This will cancel the link you already created for this referee. Continue?')) return;
      try {
        const result = await call(`/api/admin/applications/${app.id}/reference-requests`, { method: 'POST', body: { refereeIndex: index, sendEmail } });
        const linkInput = h('input', { type: 'text', readonly: true, value: result.link, 'aria-label': 'Reference link' });
        const copy = h('button', { type: 'button', class: 'btn secondary small' }, 'Copy');
        copy.addEventListener('click', async () => {
          linkInput.select();
          try {
            await navigator.clipboard.writeText(result.link);
            copy.textContent = 'Copied';
          } catch {
            document.execCommand('copy');
          }
        });
        output.replaceChildren(
          h(
            'div',
            null,
            result.emailed && alertBox('success', `Email sent to ${referee.email}.`),
            result.emailError && alertBox('info', result.emailError),
            h('p', { class: 'small' }, `Secure link (valid until ${formatDate(result.expiresAt)}). It is shown only once, so copy it now if you are sending it yourself:`),
            h('div', { class: 'link-box' }, linkInput, copy)
          )
        );
      } catch (error) {
        output.replaceChildren(alertBox('error', error.message));
      }
    }

    const actions = h(
      'div',
      { class: 'btn-row' },
      state.me.mailEnabled && h('button', { type: 'button', class: 'btn small', onclick: () => createLink(true) }, 'Email reference request'),
      h('button', { type: 'button', class: 'btn secondary small', onclick: () => createLink(false) }, 'Create reference link'),
      latest &&
        latest.status === 'pending' &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn danger small',
            onclick: async () => {
              try {
                await call(`/api/admin/reference-requests/${latest.id}/revoke`, { method: 'POST' });
                await showApplication(app.id);
              } catch (error) {
                output.replaceChildren(alertBox('error', error.message));
              }
            },
          },
          'Cancel link'
        )
    );

    const completed = requests.filter((r) => r.status === 'completed' && r.response);
    const responses = completed.map((r) =>
      h(
        'div',
        { class: 'card' },
        h('h3', null, `Reference received ${formatDate(r.completedAt, true)}`),
        [
          ['Relationship', r.response.relationship],
          ['Known for', r.response.knownFor],
          ['Strengths', r.response.strengths],
          ['Areas to develop', r.response.development],
          ['Would work with / employ again', { yes: 'Yes', no: 'No', not_applicable: 'Not applicable' }[r.response.wouldReemploy]],
          ['Other comments', r.response.comments],
        ].map(([q, a]) => h('div', { class: 'qa' }, h('div', { class: 'q' }, q), h('div', { class: 'pre' }, a || '—')))
      )
    );

    return h(
      'div',
      { class: 'referee' },
      h('div', { class: 'referee-head' }, h('h3', null, referee.name), latest && h('span', null, 'Request: ', statusBadge(latest.status))),
      h(
        'dl',
        { class: 'details' },
        h('dt', null, 'Relationship'), h('dd', null, referee.relationship),
        h('dt', null, 'Organisation'), h('dd', null, referee.organisation || '—'),
        h('dt', null, 'Email'), h('dd', null, referee.email),
        h('dt', null, 'Phone'), h('dd', null, referee.phone || '—')
      ),
      latest && latest.status === 'pending' && h('p', { class: 'muted small' }, `Link sent ${formatDate(latest.createdAt)}, expires ${formatDate(latest.expiresAt)}.`),
      responses,
      h('div', { class: 'field' }, actions),
      output
    );
  }

  // ---- Jobs ------------------------------------------------------------------

  async function showJobs() {
    const { jobs } = await call('/api/admin/jobs');
    const list = jobs.map((job) => {
      const publicLink = `${location.origin}/jobs/${job.slug}`;
      return h(
        'div',
        { class: 'card' },
        h('div', { class: 'referee-head' }, h('h2', null, job.title), h('span', { class: `status ${job.isOpen ? 'completed' : 'expired'}` }, job.isOpen ? 'Open' : 'Closed')),
        h('p', { class: 'muted small' }, [job.location, job.employmentType, `${job.applicationCount} application(s)`, `${job.questions.length} question(s)`].filter(Boolean).join(' · ')),
        job.isOpen && h('p', { class: 'small' }, 'Public link: ', h('a', { href: publicLink, target: '_blank', rel: 'noopener' }, publicLink)),
        h('div', { class: 'btn-row' }, h('a', { class: 'btn secondary small', href: `#job/${job.id}` }, 'Edit'), job.applicationCount > 0 && h('a', { class: 'btn secondary small', href: '#applications', onclick: () => { filters.jobId = job.id; filters.status = ''; } }, 'View applications'))
      );
    });
    render(
      h('div', { class: 'referee-head' }, h('h1', null, 'Jobs'), h('a', { class: 'btn', href: '#job/new' }, '+ New job')),
      list.length ? list : h('div', { class: 'card muted' }, 'No jobs yet.')
    );
  }

  function questionEditor(question = { label: '', type: 'short_text', required: false, options: [] }) {
    const label = h('input', { type: 'text', maxlength: 300, value: question.label, 'aria-label': 'Question' });
    const type = h('select', { 'aria-label': 'Answer type' }, Object.entries(QUESTION_TYPES).map(([value, text]) => h('option', { value }, text)));
    type.value = question.type;
    const required = h('input', { type: 'checkbox', checked: question.required });
    const options = h('textarea', { 'aria-label': 'Options, one per line', value: (question.options || []).join('\n'), placeholder: 'One option per line' });
    const optionsField = h('div', { class: 'field' }, h('span', { class: 'label' }, 'Options (one per line)'), options);
    const syncOptions = () => {
      optionsField.hidden = type.value !== 'single_choice';
    };
    type.addEventListener('change', syncOptions);
    syncOptions();
    const block = h(
      'div',
      { class: 'question-editor' },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Question'), label),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Answer type'), type), h('div', { class: 'field' }, h('label', { class: 'choice' }, required, 'Required'))),
      optionsField,
      h('button', { type: 'button', class: 'btn danger small', onclick: () => block.remove() }, 'Remove question')
    );
    block.read = () => ({
      ...(question.id ? { id: question.id } : {}),
      label: label.value.trim(),
      type: type.value,
      required: required.checked,
      ...(type.value === 'single_choice' ? { options: options.value.split('\n').map((o) => o.trim()).filter(Boolean) } : {}),
    });
    return block;
  }

  async function showJobEditor(id) {
    const isNew = !id || id === 'new';
    const job = isNew
      ? { title: '', location: '', employmentType: '', description: '', questions: [], referencesRequired: 2, isOpen: true }
      : (await call(`/api/admin/jobs/${encodeURIComponent(id)}`)).job;

    const field = (label, control, hint) => {
      control.id ||= `j-${label.replace(/\W+/g, '-').toLowerCase()}`;
      return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint && h('span', { class: 'hint' }, hint));
    };
    const title = h('input', { type: 'text', maxlength: 150, value: job.title, 'data-field': 'title' });
    const locationInput = h('input', { type: 'text', maxlength: 150, value: job.location, 'data-field': 'location' });
    const employmentType = h('input', { type: 'text', maxlength: 60, value: job.employmentType, placeholder: 'e.g. Full-time', 'data-field': 'employmentType' });
    const description = h('textarea', { maxlength: 20000, value: job.description, 'data-field': 'description', rows: 10 });
    const references = h('select', { 'data-field': 'referencesRequired' }, [0, 1, 2, 3, 4, 5].map((n) => h('option', { value: String(n) }, String(n))));
    references.value = String(job.referencesRequired);
    const isOpen = h('input', { type: 'checkbox', checked: job.isOpen });
    const questions = h('div', null, job.questions.map((q) => questionEditor(q)));
    const status = h('div', { 'aria-live': 'polite' });
    const save = h('button', { type: 'submit', class: 'btn' }, isNew ? 'Create job' : 'Save changes');

    const form = h(
      'form',
      { class: 'card', novalidate: true },
      field('Job title', title),
      h('div', { class: 'grid-2' }, field('Location', locationInput), field('Employment type', employmentType)),
      field('Description', description, 'Plain text. Line breaks are kept.'),
      field('Referees required', references, 'Applicants must list at least this many referees (they can add up to 5).'),
      h('div', { class: 'field' }, h('label', { class: 'choice' }, isOpen, 'Open for applications (visible on the careers page)')),
      h('h2', null, 'Application questions'),
      h('p', { class: 'muted small' }, 'Name, email, phone, location, CV, cover letter and referees are always collected. Add any extra questions here.'),
      questions,
      h('p', null, h('button', { type: 'button', class: 'btn secondary small', onclick: () => questions.append(questionEditor()) }, '+ Add question')),
      status,
      h(
        'div',
        { class: 'btn-row' },
        save,
        !isNew &&
          h(
            'button',
            {
              type: 'button',
              class: 'btn danger',
              onclick: async () => {
                if (!confirm('Delete this job? Jobs with applications can only be closed.')) return;
                try {
                  await call(`/api/admin/jobs/${job.id}`, { method: 'DELETE' });
                  go('jobs');
                } catch (error) {
                  status.replaceChildren(alertBox('error', error.message));
                }
              },
            },
            'Delete job'
          )
      )
    );

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.replaceChildren();
      const body = {
        title: title.value.trim(),
        location: locationInput.value.trim(),
        employmentType: employmentType.value.trim(),
        description: description.value.trim(),
        referencesRequired: Number(references.value),
        isOpen: isOpen.checked,
        questions: [...questions.children].map((block) => block.read()),
      };
      save.disabled = true;
      try {
        await call(isNew ? '/api/admin/jobs' : `/api/admin/jobs/${job.id}`, { method: isNew ? 'POST' : 'PUT', body });
        go('jobs');
      } catch (error) {
        showFieldErrors(form, error.fields);
        const questionErrors = Object.entries(error.fields || {}).filter(([key]) => key.startsWith('questions.'));
        const detail = questionErrors.length ? ` Question ${Number(questionErrors[0][0].split('.')[1]) + 1}: ${questionErrors[0][1]}` : '';
        status.replaceChildren(alertBox('error', error.message + detail));
        save.disabled = false;
      }
    });

    render(h('p', null, h('a', { href: '#jobs' }, '← All jobs')), h('h1', null, isNew ? 'New job' : `Edit: ${job.title}`), form);
  }

  // ---- Activity log ----------------------------------------------------------

  async function showActivity() {
    const { entries } = await call('/api/admin/audit');
    render(
      h('h1', null, 'Activity'),
      h('p', { class: 'muted' }, 'Every sign-in and every time applicant data is viewed, downloaded, changed or deleted. Kept for one year.'),
      h(
        'div',
        { class: 'table-wrap card' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, ['When', 'Who', 'Action', 'Record', 'IP address'].map((t) => h('th', null, t)))),
          h(
            'tbody',
            null,
            entries.map((entry) =>
              h(
                'tr',
                null,
                h('td', null, formatDate(entry.createdAt, true)),
                h('td', null, entry.username || (entry.action.startsWith('retention') ? 'system' : '—')),
                h('td', null, entry.action),
                h('td', { class: 'small muted' }, entry.target || ''),
                h('td', { class: 'small muted' }, entry.ip || '')
              )
            )
          )
        )
      )
    );
  }

  // ---- Account ---------------------------------------------------------------

  function showAccount() {
    const current = h('input', { type: 'password', id: 'current', autocomplete: 'current-password', 'data-field': 'currentPassword' });
    const next = h('input', { type: 'password', id: 'new', autocomplete: 'new-password', minlength: 12, 'data-field': 'newPassword' });
    const repeat = h('input', { type: 'password', id: 'repeat', autocomplete: 'new-password' });
    const status = h('div', { 'aria-live': 'polite' });
    const form = h(
      'form',
      { class: 'card login-card' },
      h('h2', null, 'Change password'),
      h('div', { class: 'field' }, h('label', { for: 'current' }, 'Current password'), current),
      h('div', { class: 'field' }, h('label', { for: 'new' }, 'New password'), next, h('span', { class: 'hint' }, 'At least 12 characters. A few random words work well.')),
      h('div', { class: 'field' }, h('label', { for: 'repeat' }, 'Repeat new password'), repeat),
      status,
      h('button', { type: 'submit', class: 'btn' }, 'Change password'),
      h('p', { class: 'muted small' }, 'Changing your password signs you out on all other devices. To reset your authenticator app, run "npm run create-admin" on the server.')
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (next.value !== repeat.value) {
        status.replaceChildren(alertBox('error', 'The new passwords do not match.'));
        return;
      }
      try {
        const result = await call('/api/admin/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
        state.csrf = result.csrfToken;
        form.reset();
        status.replaceChildren(alertBox('success', 'Password changed.'));
      } catch (error) {
        showFieldErrors(form, error.fields);
        status.replaceChildren(alertBox('error', error.message));
      }
    });
    render(h('h1', null, 'Account'), h('p', null, `Signed in as ${state.me.username}.`), form);
  }

  // ---- Start -----------------------------------------------------------------

  async function start() {
    try {
      state.me = await api('/api/admin/me');
      state.csrf = state.me.csrfToken;
      nav.hidden = false;
      await route();
    } catch (error) {
      if (error.status === 401) showLogin();
      else render(alertBox('error', error.message));
    }
  }

  loadCompany();
  start();
})();
