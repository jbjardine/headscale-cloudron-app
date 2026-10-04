// Real packaged pages, real local Headscale. Never uses production credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
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
      fs.writeFileSync(path.join(data, 'acl.hujson'), JSON.stringify({tagOwners: {'tag:browser-qa': []}}));
      const args = ['run', '-d', '--name', container, '-p', '127.0.0.1:' + port + ':8080', '-e', 'CLOUDRON_APP_ORIGIN=' + base, '--mount', 'type=bind,src=' + data + ',dst=/app/data'];
      if (process.env.CODEX_PROXY_CERT) args.push('--mount', 'type=bind,src=' + process.env.CODEX_PROXY_CERT + ',dst=/run/cloud-proxy-ca.pem,readonly', '-e', 'SSL_CERT_FILE=/run/cloud-proxy-ca.pem');
      docker(...args, target);
    }
    const proxy = process.env.HTTPS_PROXY ? {server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost'} : undefined;
    browser = await chromium.launch({headless: true, proxy});
    const context = await browser.newContext({viewport: {width: 1366, height: 900}, timezoneId: 'Europe/Paris', permissions: ['clipboard-read', 'clipboard-write']});
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
    const post = async (path, data) => {
      const response = await request.post(base + '/web/api/v1/' + path, {headers: {'X-Headscale-UI': '1'}, data});
      assert(response.ok(), path + ': ' + await response.text());return response.json();
    };
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
    await dialog.getByRole('button', {name: 'Close', exact: true}).click();
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
    // Users, keys, settings and the gateway must share the same navigation.
    await page.goto(base + '/web/users.html');
    const userCard = page.locator('details[data-user-id="' + created.user.id + '"]');
    await userCard.locator('summary').click();
    assert.equal(await userCard.locator('table').count(), 0, 'Expired key history crowds the user details');
    await userCard.getByRole('button', {name: 'Rename user', exact: true}).click();
    await page.getByRole('dialog').getByLabel('Username', {exact: true}).fill(username + '-renamed');
    await page.getByRole('button', {name: 'Save name', exact: true}).click();
    await page.getByText('User renamed.', {exact: true}).waitFor();
    await capture('01-users-desktop');
    await userCard.getByRole('link', {name: 'Create enrollment key', exact: true}).click();
    await page.waitForFunction(() => !document.getElementById('create-key').disabled);
    assert.equal(await page.getByLabel('Headscale user', {exact: true}).inputValue(), String(created.user.id));
    const userCreation = page.waitForResponse(r => r.url().endsWith('/api/v1/preauthkey') && r.request().method() === 'POST');
    const [userResponse] = await Promise.all([userCreation, page.getByRole('button', {name: 'Create enrollment key', exact: true}).click()]);
    const userKey = (await userResponse.json()).preAuthKey;
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByLabel('Your enrollment key').inputValue(), userKey.key);
    await page.getByRole('button', {name: 'Close', exact: true}).click();
    // Register real disposable nodes: grouping and administration must work with Headscale's actual schema.
    const fixtureUsers = [{id: created.user.id, name: username + '-renamed'}];
    for (const name of ['alice', 'operations', 'family']) fixtureUsers.push((await post('user', {name})).user);
    const fixtureNodes = [];
    for (let i = 0; i < 20; i++) {
      const user = fixtureUsers[i % fixtureUsers.length];
      const key = 'hskey-authreq-' + crypto.randomBytes(12).toString('hex');
      await post('debug/node', {user: user.name, name: i === 0 ? 'nas-browser' : 'machine-' + String(i).padStart(2, '0'), key});
      if (i === 0) {
        await page.goto(base + '/web/devices.html');
        await page.getByText('Register a machine with a registration key', {exact: true}).click();
        await page.waitForFunction(() => document.getElementById('register-user').options.length > 0);
        await page.getByLabel('Headscale user', {exact: true}).selectOption(String(user.id));
        await page.getByLabel('Registration key', {exact: true}).fill(key);
        await page.getByRole('button', {name: 'Register machine', exact: true}).click();
        await page.getByText('Machine registered.', {exact: true}).waitFor();
        assert.equal(await page.getByLabel('Registration key', {exact: true}).inputValue(), '');
        const result = await (await request.get(base + '/web/api/v1/node')).json();fixtureNodes.push(result.nodes[0]);
      } else {
        fixtureNodes.push((await post('node/register?user=' + encodeURIComponent(user.name) + '&key=' + encodeURIComponent(key))).node);
      }
    }
    await page.goto(base + '/web/devices.html');
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 20);
    assert.equal(await page.locator('.pkg-device-group').count(), 4);
    assert.equal(await page.getByRole('button', {name: 'Group by user', exact: true}).getAttribute('aria-pressed'), 'true');
    const group = page.locator('[data-group-user-id="' + created.user.id + '"]');
    assert.equal(await group.getAttribute('open'), '');
    await group.locator(':scope > summary').click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('headscale-package-collapsed-users') || '[]').includes(id), String(created.user.id));
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 20);
    assert.equal(await group.getAttribute('open'), null, 'Collapsed user group was not restored');
    await page.getByLabel('Find a machine', {exact: true}).fill('nas-browser');
    assert.equal(await group.getAttribute('open'), '', 'Search did not reveal a matching collapsed group');
    await page.getByLabel('Find a machine', {exact: true}).fill('');
    assert.equal(await group.getAttribute('open'), null, 'Search overwrote the saved collapse preference');
    await group.locator(':scope > summary').click();
    await page.getByLabel('Find a machine', {exact: true}).fill('nas-browser');
    assert.equal(await page.locator('[data-node-id]').count(), 1);
    await page.getByLabel('Find a machine', {exact: true}).fill('');
    await page.getByLabel('User', {exact: true}).selectOption(String(created.user.id));
    assert.equal(await page.locator('[data-node-id]').count(), 5);
    await page.getByLabel('User', {exact: true}).selectOption('');
    await page.getByRole('button', {name: 'Group by user', exact: true}).click();
    assert.equal(await page.locator('.pkg-device-group').count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 20);
    assert.equal(await page.locator('.pkg-device-group').count(), 0, 'Grouping preference was not retained');
    await page.getByRole('button', {name: 'Group by user', exact: true}).click();
    const device = page.locator('[data-node-id="' + fixtureNodes[0].id + '"]');
    await device.locator('summary').click();
    await device.getByText('No expiry', {exact: true}).waitFor();
    await device.getByRole('button', {name: 'Rename machine', exact: true}).click();
    await page.getByRole('dialog').getByLabel('Machine name', {exact: true}).fill('nas-renamed');
    await page.getByRole('dialog').getByRole('button', {name: 'Save name', exact: true}).click();
    await page.getByText('Machine renamed.', {exact: true}).waitFor();
    assert.equal(await device.getAttribute('open'), '', 'Open machine was lost after refreshing');
    const taggedDevice = page.locator('[data-node-id="' + fixtureNodes[2].id + '"]');
    await taggedDevice.locator('summary').click();
    await taggedDevice.getByRole('button', {name: 'Edit tags', exact: true}).click();
    await page.getByRole('dialog').getByLabel('Tags', {exact: true}).fill('tag:not-in-policy');
    await page.getByRole('dialog').getByRole('button', {name: 'Save tags', exact: true}).click();
    await page.getByRole('dialog').getByRole('alert').filter({hasText: 'invalid or not permitted'}).waitFor();
    await page.getByRole('dialog').getByLabel('Tags', {exact: true}).fill('tag:browser-qa');
    await page.getByRole('dialog').getByRole('button', {name: 'Save tags', exact: true}).click();
    await page.getByText('Machine tags saved.', {exact: true}).waitFor();
    await taggedDevice.getByText('tag:browser-qa', {exact: true}).waitFor();
    assert.equal(await page.locator('[data-group-user-id=tagged] [data-node-id]').count(), 1, 'Tagged machine retained user ownership');
    await post('node/' + fixtureNodes[0].id + '/approve_routes', {routes: ['10.13.0.0/24']});
    await page.getByRole('button', {name: 'Refresh', exact: true}).click();
    await device.getByLabel('10.13.0.0/24', {exact: true}).uncheck();
    await device.getByRole('button', {name: 'Save approved routes', exact: true}).click();
    await page.getByText('Approved routes saved.', {exact: true}).waitFor();
    let realNodes = (await (await request.get(base + '/web/api/v1/node')).json()).nodes;
    assert.equal(realNodes.find(n => n.id === fixtureNodes[0].id).approvedRoutes.length, 0);
    await device.getByRole('button', {name: 'Expire machine', exact: true}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Expire machine', exact: true}).click();
    await page.getByText('Machine expired.', {exact: true}).waitFor();
    realNodes = (await (await request.get(base + '/web/api/v1/node')).json()).nodes;
    assert(Date.parse(realNodes.find(n => n.id === fixtureNodes[0].id).expiry) <= Date.now());
    await capture('08-devices-desktop');
    const disposable = page.locator('[data-node-id="' + fixtureNodes[1].id + '"]');
    await disposable.locator('summary').click();
    await disposable.getByRole('button', {name: 'Delete machine', exact: true}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
    assert.equal(await disposable.count(), 1, 'Cancel deleted a machine');
    await disposable.getByRole('button', {name: 'Delete machine', exact: true}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Delete machine', exact: true}).click();
    await page.getByText('Machine deleted.', {exact: true}).waitFor();
    assert.equal(await disposable.count(), 0);
    await page.goto(base + '/web/users.html');
    await page.getByRole('button', {name: 'New user', exact: true}).click();
    await page.getByRole('dialog').getByLabel('Username', {exact: true}).fill('disposable-user');
    await page.getByRole('dialog').getByRole('button', {name: 'Create user', exact: true}).click();
    await page.getByText('User created.', {exact: true}).waitFor();
    const disposableUser = page.locator('[data-user-id]').filter({hasText: 'disposable-user'});
    await disposableUser.getByRole('button', {name: 'Delete user', exact: true}).click();
    await page.getByRole('dialog').getByRole('button', {name: 'Delete user', exact: true}).click();
    await page.getByText('User deleted.', {exact: true}).waitFor();
    assert.equal(await disposableUser.count(), 0);
    await userCard.locator('summary').click();
    assert.equal(await userCard.getByRole('button', {name: 'Delete user', exact: true}).isEnabled(), false, 'User with machines can be deleted');
    await userCard.getByRole('link', {name: 'View machines', exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 5);
    assert.equal(await page.getByLabel('User', {exact: true}).inputValue(), String(created.user.id));
    await page.goto(base + '/web/settings.html');
    await page.getByText('Connected', {exact: true}).waitFor();
    assert.equal(await page.getByLabel('Login server', {exact: true}).inputValue(), base);
    assert.equal(await page.locator('input[type=password]').count(), 0, 'Settings ask for a browser API credential');
    const info = await (await request.get(base + '/web/api/v1/package/info')).json();
    await page.locator('#versions').getByText(info.version, {exact: true}).waitFor();
    assert.deepEqual(await page.locator('#versions dd').allTextContents(), [info.version, info.headscaleVersion, info.upstreamUiVersion]);
    await capture('07-settings-desktop');
    await page.getByLabel('Theme', {exact: true}).selectOption('dark');
    await page.getByRole('link', {name: 'Users', exact: true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    assert.equal(await page.getByLabel('Theme', {exact: true}).inputValue(), 'dark');
    await page.getByLabel('Theme', {exact: true}).selectOption('light');
    await page.getByRole('link', {name: 'Tailscale gateway', exact: true}).first().click();
    await page.getByRole('button', {name: 'Save', exact: true}).waitFor({state: 'visible'});
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await page.getByLabel('Enable gateway').isChecked(), false);
    await capture('04-gateway-desktop');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await page.getByText('Saved. Gateway disabled.', {exact: true}).waitFor();
    await page.getByLabel('Enable gateway').check();
    await page.getByLabel('Headscale user').selectOption(String(created.user.id));
    await page.getByRole('button', {name: 'Save', exact: true}).click();
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
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await page.getByText('Saved. Gateway disabled.', {exact: true}).waitFor();
    const savedGateway = await (await request.get(base + '/web/api/v1/package/gateway')).json();
    assert(savedGateway.settings.rules.every(rule => rule.targetIp === 'fd7a:115c:a1e0::7'));
    assert.equal(savedGateway.settings.enabled, false);
    await context.unroute('**/web/api/v1/node');
    savedGateway.settings.rules = [{nodeId: fixtureNodes[0].id, targetIp: fixtureNodes[0].ipAddresses[0], targetPort: 445, listenPort: 1445}];
    assert((await request.put(base + '/web/api/v1/package/gateway', {headers: {'X-Headscale-UI': '1'}, data: savedGateway.settings})).ok());
    const pages = [['users', 'Users'], ['devices', 'Devices'], ['keys', 'Enrollment keys'], ['gateway', 'Tailscale gateway'], ['settings', 'Settings']];
    const ready = async name => {
      if (name === 'users') await page.waitForFunction(() => !document.getElementById('refresh-users').disabled);
      if (name === 'devices') await page.waitForFunction(() => !document.getElementById('refresh-devices').disabled);
      if (name === 'keys') await page.waitForFunction(() => !document.getElementById('create-key').disabled && !document.getElementById('key-list').textContent.startsWith('Loading keys'));
      if (name === 'gateway') await page.waitForFunction(() => !document.getElementById('save').disabled);
      if (name === 'settings') await page.getByText('Connected', {exact: true}).waitFor();
    };
    // Check every page, both direct entry and navigation, at the reported width and at phone width.
    for (const [size, viewport] of [['desktop', {width: 1366, height: 900}], ['reported', {width: 1039, height: 911}], ['mobile', {width: 390, height: 844}]]) {
      await page.setViewportSize(viewport);await page.goto(base + '/web/');await ready('users');
      assert.equal(await page.locator('.pkg-sidebar [aria-current=page]').textContent(), 'Users');
      let shared;
      for (const [name, label] of pages) {
        await page.locator('.pkg-sidebar').getByRole('link', {name: label, exact: true}).click();await ready(name);
        assert.equal(await page.locator('.pkg-sidebar nav a').count(), 5);
        assert.equal(await page.locator('.pkg-sidebar [aria-current=page]').count(), 1);
        assert.equal(await page.locator('.pkg-sidebar [aria-current=page]').textContent(), label);
        const layout = await page.evaluate(() => {
          const boxes = [...document.querySelectorAll('.pkg-brand, .pkg-sidebar nav a')].map(el => el.getBoundingClientRect());
          const overlaps = boxes.some((a, i) => boxes.slice(i + 1).some(b => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)));
          const title = document.querySelector('h1').getBoundingClientRect();
          return {overlaps, overflow: document.documentElement.scrollWidth > innerWidth, shared: [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.querySelector('.pkg-sidebar')).backgroundColor, title.x, title.y]};
        });
        assert.equal(layout.overlaps, false, name + ': navigation overlaps');
        assert.equal(layout.overflow, false, name + ': horizontal overflow at ' + size);
        if (!shared) shared = layout.shared;else assert.deepEqual(layout.shared, shared, 'Page changed the shared interface: ' + name);
        if (name === 'devices' && size === 'mobile') {
          const lines = await page.locator('[data-group-user-id="' + fixtureUsers[1].id + '"] > summary .pkg-entry-name').evaluate(el => {const range = document.createRange();range.selectNodeContents(el);return range.getClientRects().length;});
          assert.equal(lines, 1, 'A short user name wraps inside the mobile group header');
        }
        if (name === 'users') await page.locator('[data-user-id="' + created.user.id + '"] > summary').click();
        if (evidence) await page.screenshot({path: path.join(evidence, name + '-' + size + '.png'), fullPage: name !== 'devices'});
      }
    }
    await page.setViewportSize({width: 1366, height: 900});
    await page.getByLabel('Theme', {exact: true}).selectOption('dark');
    for (const [name, label] of pages) {
      await page.locator('.pkg-sidebar').getByRole('link', {name: label, exact: true}).click();await ready(name);
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');await capture(name + '-dark');
    }
    await page.getByLabel('Theme', {exact: true}).selectOption('light');
    assert.deepEqual(failures, [], 'Browser JavaScript errors');
    console.log('Browser smoke passed: real users/keys/device CRUD, registration, tags, routes, expiry, grouped devices and preferences; all five pages and themes at desktop/reported/mobile sizes; gateway save/errors and IPv6; no production VPN enrollment');
  } catch (error) {
    if (browser) {
      const page = browser.contexts()[0]?.pages()[0];
      if (page) {
        console.error('UI failure at ' + new URL(page.url()).pathname + ': ' + await page.locator('#message').textContent());
        const errors = await page.locator('dialog [role=alert]').allTextContents();if (errors.length) console.error(errors.join('\n'));
        if (evidence) await page.screenshot({path: path.join(evidence, 'failure.png'), fullPage: true});
      }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    if (container) {
      try { docker('exec', container, 'chown', '-R', process.getuid() + ':' + process.getgid(), '/app/data'); } catch (_) {}
      try { docker('rm', '-f', container); } catch (_) {}
    }
    if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
  }
})().catch(error => { console.error(error.message);process.exitCode = 1; });
