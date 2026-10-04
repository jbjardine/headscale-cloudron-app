// Real packaged pages, real local Headscale. Never uses production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');

(async () => {
  const target = process.argv[2];
  assert(target, 'Pass a local test image, or the URL of a disposable localhost fixture');
  const dockerArgs = process.env.HEADSCALE_TEST_DOCKER_HOST ? ['--host=' + process.env.HEADSCALE_TEST_DOCKER_HOST] : [];
  const docker = (...args) => execFileSync('docker', [...dockerArgs, ...args], {encoding: 'utf8'}).trim();
  let base, container, temporary, browser;
  const evidence = process.env.HEADSCALE_QA_DIR;
  if (evidence) fs.mkdirSync(evidence, {recursive: true});
  const failures = [];
  try {
    if (target.startsWith('http')) {
      base = new URL(target).origin;
      assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Browser fixtures must be local');
    } else {
      const port = await new Promise(resolve => { const s = net.createServer();s.listen(0, '127.0.0.1', () => { const port = s.address().port;s.close(() => resolve(port)); }); });
      base = 'http://127.0.0.1:' + port;
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'headscale-browser-'));
      container = 'headscale-browser-' + process.pid;
      const data = path.join(temporary, 'data');fs.mkdirSync(data);
      const args = ['run', '-d', '--name', container, '-p', '127.0.0.1:' + port + ':8080', '-e', 'CLOUDRON_APP_ORIGIN=' + base, '--mount', 'type=bind,src=' + data + ',dst=/app/data'];
      if (process.env.CODEX_PROXY_CERT) args.push('--mount', 'type=bind,src=' + process.env.CODEX_PROXY_CERT + ',dst=/run/cloud-proxy-ca.pem,readonly', '-e', 'SSL_CERT_FILE=/run/cloud-proxy-ca.pem');
      docker(...args, target);
    }
    const proxy = process.env.HTTPS_PROXY ? {server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost'} : undefined;
    browser = await chromium.launch({headless: true, proxy});
    const context = await browser.newContext({viewport: {width: 1366, height: 900}, permissions: ['clipboard-read', 'clipboard-write']});
    const request = context.request;
    const deadline = Date.now() + 90000;
    while (true) {
      try { if ((await request.get(base + '/web/api/v1/user', {timeout: 1000})).ok()) break; } catch (_) {}
      assert(Date.now() < deadline, 'Packaged UI did not become ready');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    const capture = async name => { if (evidence) await page.screenshot({path: path.join(evidence, name + '.png'), fullPage: true}); };
    const username = 'browser-' + Date.now();
    await page.goto(base + '/web/keys.html');
    await page.getByText('Create a user', {exact: true}).click();
    await page.getByLabel('Username', {exact: true}).fill(username);
    await page.getByRole('button', {name: 'Create user', exact: true}).click();
    await page.getByText('User created.', {exact: true}).waitFor();
    await page.waitForFunction(() => !document.getElementById('create-key').disabled);
    await capture('02-keys-desktop');
    const creation = page.waitForResponse(r => r.url().endsWith('/api/v1/preauthkey') && r.request().method() === 'POST');
    const [creationResponse] = await Promise.all([creation, page.getByRole('button', {name: 'Create enrollment key', exact: true}).click()]);
    const created = (await creationResponse.json()).preAuthKey;
    assert(created.key, 'Headscale did not return the one-time enrollment secret');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const secret = page.getByLabel('Your enrollment key');
    assert.equal(await secret.inputValue(), created.key);
    assert.equal(await secret.getAttribute('type'), 'password');
    await dialog.getByRole('button', {name: 'Copy key', exact: true}).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), created.key);
    await dialog.getByRole('button', {name: 'Show key', exact: true}).click();
    assert.equal(await secret.getAttribute('type'), 'text');
    await dialog.getByRole('button', {name: 'Hide key', exact: true}).click();
    await capture('03-key-created-masked');
    await dialog.getByRole('button', {name: 'Done — I saved the key', exact: true}).click();
    await page.locator('#pkg-key-value').waitFor({state: 'detached'});
    assert.equal(await page.locator('#pkg-key-value').count(), 0, 'Secret was retained after closing');
    const expiry = page.waitForResponse(r => r.url().endsWith('/preauthkey/expire') && r.request().method() === 'POST');
    const [expiryResponse] = await Promise.all([expiry, page.getByRole('button', {name: 'Expire enrollment key ' + created.id, exact: true}).click()]);
    assert(expiryResponse.ok());
    await page.getByText('Key expired. Existing machines remain registered.').waitFor();
    const listed = await (await request.get(base + '/web/api/v1/preauthkey?user=' + created.user.id)).json();
    assert(Date.parse(listed.preAuthKeys.find(k => k.id === created.id).expiration) <= Date.now());
    // Display-only API fixture for non-expiring keys; no fake key is revoked.
    const noExpiryPattern = '**/web/api/v1/preauthkey?user=*';
    const noExpiryRoute = async route => route.fulfill({json: {preAuthKeys: [
      {id: '9001', expiration: null, reusable: true, used: false},
      {id: '9002', reusable: true, used: false},
      {id: '9003', expiration: '2000-01-01T00:00:00Z', reusable: true, used: false},
    ]}});
    await context.route(noExpiryPattern, noExpiryRoute);
    await page.reload();
    for (const id of ['9001', '9002']) {
      const row = page.locator('#key-list tbody tr').filter({hasText: '#' + id});
      await row.getByText('No expiry', {exact: true}).waitFor();
      await row.getByText('Active', {exact: true}).waitFor();
      assert.equal(await row.getByRole('button', {name: 'Expire enrollment key ' + id, exact: true}).isEnabled(), true);
    }
    const expiredFixture = page.locator('#key-list tbody tr').filter({hasText: '#9003'});
    await expiredFixture.getByText('Expired', {exact: true}).waitFor();
    assert.equal(await expiredFixture.getByRole('button').count(), 0);
    await context.unroute(noExpiryPattern, noExpiryRoute);
    // The upstream UI must also show the secret it previously discarded.
    await page.goto(base + '/web/users.html');
    await page.getByText(username).click();
    await page.locator('th').filter({hasText: 'Preauth Keys'}).getByRole('button').click();
    const legacyCreation = page.waitForResponse(r => r.url().endsWith('/api/v1/preauthkey') && r.request().method() === 'POST');
    const [legacyResponse] = await Promise.all([legacyCreation, page.getByRole('button', {name: 'Create Preauth Key', exact: true}).click()]);
    const legacy = (await legacyResponse.json()).preAuthKey;
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByLabel('Your enrollment key').inputValue(), legacy.key);
    await page.getByRole('button', {name: 'Done — I saved the key', exact: true}).click();
    await page.getByRole('link', {name: 'Tailscale gateway', exact: true}).first().click();
    await page.getByRole('button', {name: 'Save gateway settings', exact: true}).waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await page.getByLabel('Enable this optional gateway').isChecked(), false);
    await capture('04-gateway-desktop');
    await page.getByRole('button', {name: 'Save gateway settings', exact: true}).click();
    await page.getByText('Gateway disabled. No services are forwarded.', {exact: true}).waitFor();
    await page.getByLabel('Enable this optional gateway').check();
    await page.getByLabel('Headscale user for this gateway').selectOption(String(created.user.id));
    await page.getByRole('button', {name: 'Save gateway settings', exact: true}).click();
    await page.getByText('Add an official Tailscale auth key before enabling the gateway', {exact: true}).waitFor();
    // Rendering fixture: no VPN client is enrolled and the gateway stays off.
    await context.route('**/web/api/v1/node', async route => {
      await route.fulfill({json: {nodes: [{id: '123', name: 'ipv6-only-fixture', ipAddresses: ['fd7a:115c:a1e0::7']}]}});
    });
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    await page.getByRole('button', {name: 'Add a TCP service', exact: true}).click();
    assert.equal(await page.locator('.rule-node').first().inputValue(), '123|fd7a:115c:a1e0::7', 'IPv6-only machine missing from selector');
    await page.getByRole('button', {name: 'Add a TCP service', exact: true}).click();
    assert.deepEqual(await page.locator('.rule-listen-port').evaluateAll(fields => fields.map(field => Number(field.value))), [1445, 1446]);
    await page.getByRole('button', {name: 'Remove service', exact: true}).first().click();
    await page.getByRole('button', {name: 'Add a TCP service', exact: true}).click();
    assert.deepEqual(await page.locator('.rule-listen-port').evaluateAll(fields => fields.map(field => Number(field.value))), [1446, 1445], 'A removed rule made a duplicate default port');
    await page.getByRole('button', {name: 'Save gateway settings', exact: true}).click();
    await page.getByText('Gateway disabled. No services are forwarded.', {exact: true}).waitFor();
    const savedGateway = await (await request.get(base + '/web/api/v1/package/gateway')).json();
    assert(savedGateway.settings.rules.every(rule => rule.targetIp === 'fd7a:115c:a1e0::7'));
    assert.equal(savedGateway.settings.enabled, false);
    // Responsive layout and navigation must remain usable at phone width.
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(base + '/web/keys.html');
    await page.waitForFunction(() => !document.getElementById('create-key').disabled);
    await page.waitForFunction(() => !document.getElementById('key-list').textContent.startsWith('Loading keys'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Keys page overflows on mobile');
    await capture('05-keys-mobile');
    await page.getByRole('link', {name: 'Tailscale gateway', exact: true}).first().click();
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Gateway page overflows on mobile');
    await capture('06-gateway-mobile');
    assert.deepEqual(failures, [], 'Browser JavaScript errors');
    console.log('Browser smoke passed: create user, create/copy/reveal/clear/expire key, upstream key dialog, gateway save/errors, IPv6-only destination, unused default ports, desktop/mobile layouts; no production VPN enrollment');
  } finally {
    if (browser) await browser.close();
    if (container) {
      try { docker('exec', container, 'chown', '-R', process.getuid() + ':' + process.getgid(), '/app/data'); } catch (_) {}
      try { docker('rm', '-f', container); } catch (_) {}
    }
    if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
  }
})().catch(error => { console.error(error.message);process.exitCode = 1; });
