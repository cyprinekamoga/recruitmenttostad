'use strict';

(async () => {
  const { h, api, loadCompany } = window.App;
  const container = document.getElementById('jobs');
  const config = await loadCompany();
  if (config.companyName) document.title = `Careers at ${config.companyName}`;

  try {
    const { jobs } = await api('/api/jobs');
    if (jobs.length === 0) {
      container.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'There are no open positions right now. Please check back soon.')));
      return;
    }
    container.replaceChildren(
      h(
        'ul',
        { class: 'job-list' },
        jobs.map((job) =>
          h(
            'li',
            null,
            h(
              'a',
              { class: 'card', href: `/jobs/${encodeURIComponent(job.slug)}` },
              h('h2', null, job.title),
              h('div', { class: 'tags' }, job.location && h('span', { class: 'tag' }, job.location), job.employmentType && h('span', { class: 'tag' }, job.employmentType)),
              h('p', { class: 'muted pre' }, job.summary)
            )
          )
        )
      )
    );
  } catch (error) {
    container.replaceChildren(window.App.alertBox('error', error.message));
  }
})();
