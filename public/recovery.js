// Copy for an admin's recovery code (ARCH.md §16 #100). The button is hidden until this runs; without it the code is
// still selectable whole, and its text file is a plain link — saving it needs no script.
document.querySelectorAll('button[data-copy-code]').forEach((button) => {
  const said = button.closest('.recovery-code')?.querySelector('.recovery-copied');
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copyCode);
      if (said) said.textContent = button.dataset.copied;
    } catch {
      // no clipboard here (plain http, or the permission refused): the other two ways still work
      if (said) said.textContent = button.dataset.copyFailed;
    }
  });
});
