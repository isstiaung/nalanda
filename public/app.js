// Small vanilla helpers: add-page tab switching + mobile sidebar toggle.
document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab[data-tab]');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        const active = panel.id === `tab-${tab.dataset.tab}`;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
      });
    });
  });

  // Filter dropdowns close when clicking anywhere else (incl. opening another one).
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.filter[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });

  const navToggle = document.getElementById('nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', () => document.body.classList.toggle('nav-open'));
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) document.body.classList.remove('nav-open');
    });
  }
});
