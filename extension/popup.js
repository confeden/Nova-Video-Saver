// Action popup: shows the installed version and the update-check state that
// background.js keeps in chrome.storage.local under 'nova_update'.

const statusBox = document.getElementById('status');
const releaseLink = document.getElementById('release-link');
const recheckButton = document.getElementById('recheck');

document.getElementById('current-version').textContent = `v${chrome.runtime.getManifest().version}`;

function render(state) {
  releaseLink.hidden = true;
  statusBox.className = 'status';
  if (!state || (!state.checkedAt && !state.error)) {
    statusBox.textContent = 'Обновления ещё не проверялись.';
    return;
  }
  if (state.available) {
    statusBox.classList.add('update');
    statusBox.textContent = `Доступна новая версия v${state.latest}!`;
    releaseLink.href = state.releaseUrl || 'https://github.com/confeden/Nova-Video-Saver/releases';
    releaseLink.hidden = false;
    return;
  }
  if (state.error && !state.latest) {
    statusBox.classList.add('error');
    statusBox.textContent = `Не удалось проверить обновления: ${state.error}`;
    return;
  }
  const checked = state.checkedAt ? new Date(state.checkedAt).toLocaleString() : '';
  statusBox.textContent = `Установлена последняя версия.${checked ? ` Проверено: ${checked}` : ''}`;
}

async function refresh(force) {
  if (force) {
    statusBox.className = 'status';
    statusBox.textContent = 'Проверка обновлений…';
    const result = await chrome.runtime.sendMessage({ t: 'nova-check-update' }).catch((error) => ({
      error: String(error?.message || error),
    }));
    render(result);
    return;
  }
  const stored = await chrome.storage.local.get('nova_update').catch(() => ({}));
  render(stored.nova_update);
  refresh(true);
}

recheckButton.addEventListener('click', () => refresh(true));
refresh(false);

// Manual journal export: the debug file is otherwise only produced by errors,
// which hides silent misbehaviour (wasted retries, reload loops) from reports.
const exportButton = document.getElementById('export-log');
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  exportButton.textContent = 'Сохраняю журнал…';
  const result = await chrome.runtime.sendMessage({
    t: 'nova-error',
    context: 'manual-export',
    error: 'Журнал сохранён по запросу пользователя (это не ошибка).',
  }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  exportButton.disabled = false;
  exportButton.textContent = result?.ok
    ? 'Журнал сохранён в загрузки (NVS-debug.txt)'
    : `Не удалось сохранить журнал: ${result?.error || 'ошибка'}`;
});
