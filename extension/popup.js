// Action popup: shows the installed version and the update-check state that
// background.js keeps in chrome.storage.local under 'nova_update'.

const statusBox = document.getElementById('status');
const releaseLink = document.getElementById('release-link');
const recheckButton = document.getElementById('recheck');
// Always this address: GitHub redirects it to whatever the newest release is,
// so the link is correct even when the update check could not run — a
// per-version URL from nvs.json would freeze on a stale release.
const LATEST_RELEASE_URL = 'https://github.com/confeden/Nova-Video-Saver/releases/latest';

document.getElementById('current-version').textContent = `v${chrome.runtime.getManifest().version}`;

function render(state) {
  releaseLink.href = LATEST_RELEASE_URL;
  statusBox.className = 'status';
  if (!state || (!state.checkedAt && !state.error)) {
    statusBox.textContent = 'Обновления ещё не проверялись.';
    return;
  }
  if (state.available) {
    statusBox.classList.add('update');
    statusBox.textContent = `Доступна новая версия v${state.latest}!`;
    return;
  }
  if (state.error && !state.latest) {
    statusBox.classList.add('error');
    statusBox.textContent = `Не удалось проверить обновления: ${state.error}`;
    releaseLink.href = LATEST_RELEASE_URL;
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

// Files that finished processing but that the browser did not accept for
// saving (a service-worker restart at the wrong moment). They wait in the
// extension's private storage until saved from here.
const recoveredBox = document.getElementById('recovered');
const saveRecoveredButton = document.getElementById('save-recovered');

function formatSize(bytes) {
  const megabytes = Number(bytes) / (1024 * 1024);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return '';
  return megabytes >= 1024 ? ` (${(megabytes / 1024).toFixed(1)} ГБ)` : ` (${Math.round(megabytes)} МБ)`;
}

async function refreshRecovered() {
  const stored = await chrome.storage.local.get('nova_recovered').catch(() => ({}));
  const pending = (Array.isArray(stored.nova_recovered) ? stored.nova_recovered : [])
    .filter((entry) => entry && !entry.savedAt);
  recoveredBox.hidden = pending.length === 0;
  saveRecoveredButton.hidden = pending.length === 0;
  if (!pending.length) return pending.length;
  // These controls only ever appear after a download finished processing but
  // the browser refused to accept the file, so say exactly that — an unexplained
  // button here reads like a mystery feature.
  recoveredBox.textContent = pending.length === 1
    ? `Загрузка завершилась, но браузер не принял файл «${pending[0].filename}»`
      + `${formatSize(pending[0].bytes)}. Он сохранён во временном хранилище — нажмите кнопку ниже.`
    : `Готовых файлов, которые браузер не принял: ${pending.length}.`
      + ' Они сохранены во временном хранилище — нажмите кнопку ниже.';
  return pending.length;
}

saveRecoveredButton.addEventListener('click', async () => {
  saveRecoveredButton.disabled = true;
  saveRecoveredButton.textContent = 'Сохраняю…';
  const result = await chrome.runtime.sendMessage({ t: 'nova-flush-recovered' })
    .catch((error) => ({ ok: false, error: String(error?.message || error) }));
  saveRecoveredButton.disabled = false;
  saveRecoveredButton.textContent = 'Сохранить готовый файл';
  const stillPending = await refreshRecovered();
  if (!stillPending) {
    recoveredBox.hidden = false;
    recoveredBox.textContent = 'Готово: файл отправлен в загрузки браузера.';
  } else {
    recoveredBox.textContent = `Не удалось сохранить: ${result?.error || 'ошибка'}.`
      + ' Попробуйте ещё раз или перезапустите браузер.';
  }
});

refreshRecovered();

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
