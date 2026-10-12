/* HvH platform - test suite. Run: node server/test.js
   Spins the real server on a random port against a throwaway database. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvhtest-'));
process.env.DB_FILE = path.join(tmp, 'test.db');
process.env.SERVE_STATIC = '0';
process.env.TRUST_PROXY = '1';  /* the suite fakes client addresses via X-Forwarded-For */
process.env.PORT = '0';
const { server, db, api } = require('./server');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, extra) {
  if (cond) { pass++; results.push('  ok   ' + name); }
  else { fail++; results.push('  FAIL ' + name + (extra !== undefined ? '  <' + JSON.stringify(extra).slice(0, 200) + '>' : '')); }
}

let base;
async function call(method, p, { token, body, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (ip) headers['x-forwarded-for'] = ip;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}
const post = (p, o) => call('POST', p, o);
const get = (p, o) => call('GET', p, o);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;

  /* ---------- accounts and UID ---------- */
  const owner = await post('/api/register', { body: { username: 'Owner', password: 'ownerpass1', confirm: 'ownerpass1' }, ip: '10.0.0.1' });
  check('first account registers', owner.ok, owner);
  check('first account is UID 1', owner.user && owner.user.uid === 1, owner.user);
  check('first account is the owner', owner.user && owner.user.owner === true, owner.user);

  const second = await post('/api/register', { body: { username: 'Player2', password: 'playerpass1', confirm: 'playerpass1' }, ip: '10.0.0.2' });
  check('second account is UID 2', second.user && second.user.uid === 2, second.user);
  check('second account is not owner', second.user && second.user.owner === false, second.user);

  const dupe = await post('/api/register', { body: { username: 'OWNER', password: 'whatever12', confirm: 'whatever12' }, ip: '10.0.0.3' });
  check('duplicate username rejected case-insensitively', dupe.status === 409, dupe);

  const mismatch = await post('/api/register', { body: { username: 'nope1', password: 'aaaaaaaa1', confirm: 'bbbbbbbb1' }, ip: '10.0.0.3' });
  check('password confirmation enforced', mismatch.status === 400, mismatch);
  const shortPw = await post('/api/register', { body: { username: 'nope2', password: 'abc', confirm: 'abc' }, ip: '10.0.0.3' });
  check('short password rejected', shortPw.status === 400, shortPw);
  const badName = await post('/api/register', { body: { username: '_bad', password: 'aaaaaaaa1', confirm: 'aaaaaaaa1' }, ip: '10.0.0.3' });
  check('invalid username rejected', badName.status === 400, badName);

  /* concurrent registration: same name from many requests at once */
  const race = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    post('/api/register', { body: { username: 'RaceName', password: 'racepass123', confirm: 'racepass123' }, ip: '10.9.9.' + i })));
  const won = race.filter(r => r.ok);
  check('concurrent same-name registration: exactly one wins', won.length === 1, race.map(r => r.status));

  /* concurrent distinct registrations must get distinct UIDs */
  const many = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    post('/api/register', { body: { username: 'bulk' + i, password: 'bulkpass123', confirm: 'bulkpass123' }, ip: '10.8.8.' + i })));
  const uids = many.filter(r => r.ok).map(r => r.user.uid);
  check('concurrent registrations get unique UIDs', new Set(uids).size === uids.length && uids.length === 15, uids);

  const stored = db.prepare('SELECT pw FROM users WHERE uid = 1').get().pw;
  check('password is hashed, not stored plain', !stored.includes('ownerpass1') && stored.startsWith('scrypt$'), stored.slice(0, 20));

  /* ---------- login and sessions ---------- */
  const badLogin = await post('/api/login', { body: { username: 'Owner', password: 'wrong' }, ip: '10.0.0.1' });
  check('wrong password rejected', badLogin.status === 401, badLogin);
  const goodLogin = await post('/api/login', { body: { username: 'owner', password: 'ownerpass1' }, ip: '10.0.0.1' });
  check('login works and is case-insensitive on username', goodLogin.ok && goodLogin.user.uid === 1, goodLogin);
  const OT = goodLogin.token, PT = second.token;

  const me = await get('/api/me', { token: OT, ip: '10.0.0.1' });
  check('/api/me returns the session user', me.ok && me.user.uid === 1, me);
  const noTok = await get('/api/me', { ip: '10.0.0.1' });
  check('/api/me without a token is refused', noTok.status === 401, noTok);
  const junkTok = await get('/api/me', { token: 'not-a-real-token', ip: '10.0.0.1' });
  check('/api/me with a junk token is refused', junkTok.status === 401, junkTok);

  check('no password hash is ever sent to the client', !JSON.stringify(goodLogin).includes('scrypt$'), 'login body');

  /* ---------- authorisation ---------- */
  const sneak = await get('/api/admin/overview', { token: PT, ip: '10.0.0.2' });
  check('non-owner cannot reach the admin API', sneak.status === 403, sneak);
  const anon = await get('/api/admin/users', { ip: '10.0.0.9' });
  check('anonymous cannot reach the admin API', anon.status === 401, anon);
  const ov = await get('/api/admin/overview', { token: OT, ip: '10.0.0.1' });
  check('owner can reach the admin API', ov.ok && ov.accounts >= 17, ov.accounts);

  /* ---------- matches ---------- */
  const host = await post('/api/match/host', { token: OT, body: { mode: '1v1' }, ip: '10.0.0.1' });
  check('hosting a 1v1 creates a match with a code', host.ok && host.match.code && host.match.cap === 2, host.match);
  const code = host.match.code, mid = host.match.id;

  const joined = await post('/api/match/join', { token: PT, body: { code }, ip: '10.0.0.2' });
  check('a second player can join by code', joined.ok && joined.match.players.length === 2, joined.match);
  check('the match goes live when full', joined.match.status === 'live', joined.match.status);

  const third = await post('/api/login', { body: { username: 'bulk0', password: 'bulkpass123' }, ip: '10.0.0.5' });
  const overfill = await post('/api/match/join', { token: third.token, body: { code }, ip: '10.0.0.5' });
  check('a full match cannot be overfilled', overfill.status === 409, overfill);

  const badCode = await post('/api/match/join', { token: third.token, body: { code: 'ZZZZZZ' }, ip: '10.0.0.5' });
  check('a bad match code gives a clear error', badCode.status === 404, badCode);

  /* the code is only visible to players in the match */
  const outsider = await get('/api/match/state', { token: third.token, ip: '10.0.0.5' }).then(() => get('/api/match/state?id=' + mid, { token: third.token, ip: '10.0.0.5' }));
  check('a non-participant does not see the join code', outsider.ok && !outsider.match.code, outsider.match);

  /* signalling is scoped to participants */
  const sigOut = await post('/api/match/signal', { token: third.token, body: { match: mid, data: { x: 1 } }, ip: '10.0.0.5' });
  check('a non-participant cannot post signals into a match', sigOut.status === 403, sigOut);
  await post('/api/match/signal', { token: OT, body: { match: mid, data: { hello: 'offer' } }, ip: '10.0.0.1' });
  const sigIn = await get('/api/match/signal?match=' + mid + '&since=0', { token: PT, ip: '10.0.0.2' });
  check('signalling relays the handshake between the two players', sigIn.ok && sigIn.msgs.length === 1 && sigIn.msgs[0].data.hello === 'offer', sigIn);
  const sigSelf = await get('/api/match/signal?match=' + mid + '&since=0', { token: OT, ip: '10.0.0.1' });
  check('a player does not receive their own signals back', sigSelf.ok && sigSelf.msgs.length === 0, sigSelf);

  /* quick match */
  await post('/api/match/leave', { token: OT, ip: '10.0.0.1' });
  await post('/api/match/leave', { token: PT, ip: '10.0.0.2' });
  const open2 = await post('/api/match/host', { token: PT, body: { mode: '1v1' }, ip: '10.0.0.2' });
  check('host after leaving works', open2.ok, open2);
  const quick = await post('/api/match/quick', { token: OT, body: { mode: '1v1' }, ip: '10.0.0.1' });
  check('quick match finds the open lobby', quick.ok && quick.match && quick.match.id === open2.match.id, quick.match);
  await post('/api/match/leave', { token: OT, ip: '10.0.0.1' });
  await post('/api/match/leave', { token: PT, ip: '10.0.0.2' });
  const quickNone = await post('/api/match/quick', { token: OT, body: { mode: '5v5' }, ip: '10.0.0.1' });
  check('quick match with nothing available says so', quickNone.ok && quickNone.match === null, quickNone);

  /* ---------- tournaments ---------- */
  const tCreate = await post('/api/admin/tournament', { token: OT, ip: '10.0.0.1',
    body: { name: 'Autumn Cup', team_size: 1, max_teams: 16, best_of: 1, maps: 'Mirage', visibility: 'public' } });
  check('owner can create a tournament', tCreate.ok && tCreate.id, tCreate);
  const tid = tCreate.id;
  const tDeny = await post('/api/admin/tournament', { token: PT, ip: '10.0.0.2', body: { name: 'Nope', team_size: 1, max_teams: 4 } });
  check('non-owner cannot create a tournament', tDeny.status === 403, tDeny);
  const tBadSize = await post('/api/admin/tournament', { token: OT, ip: '10.0.0.1', body: { name: 'Bad', team_size: 9, max_teams: 4 } });
  check('invalid team size rejected', tBadSize.status === 400, tBadSize);

  const closedReg = await post('/api/tournament/register', { token: PT, body: { id: tid, team: 'Alpha' }, ip: '10.0.0.2' });
  check('cannot register while the tournament is a draft', closedReg.status === 409, closedReg);
  await post('/api/admin/tournament/status', { token: OT, body: { id: tid, status: 'open' }, ip: '10.0.0.1' });

  /* register 5 teams -> next power of two is 8, so 3 byes */
  const tokens = [PT];
  for (let i = 1; i <= 4; i++) {
    const l = await post('/api/login', { body: { username: 'bulk' + i, password: 'bulkpass123' }, ip: '10.0.1.' + i });
    tokens.push(l.token);
  }
  for (let i = 0; i < tokens.length; i++)
    await post('/api/tournament/register', { token: tokens[i], body: { id: tid, team: 'Team' + i }, ip: '10.0.1.' + i });
  const dupReg = await post('/api/tournament/register', { token: tokens[0], body: { id: tid, team: 'Again' }, ip: '10.0.0.2' });
  check('a player cannot register twice in one tournament', dupReg.status === 409, dupReg);

  const gen = await post('/api/admin/tournament/bracket', { token: OT, body: { id: tid }, ip: '10.0.0.1' });
  check('bracket generates for 5 teams', gen.ok && gen.size === 8 && gen.byes === 3, gen);

  let tv = await get('/api/tournament?id=' + tid, { token: OT, ip: '10.0.0.1' });
  const r1 = tv.tournament.bracket.filter(b => b.round === 1);
  check('round 1 has 4 slots', r1.length === 4, r1.length);
  const realR1 = r1.filter(b => b.team_a && b.team_b);
  check('3 byes resolve automatically, leaving 1 real first-round game', realR1.length === 1, r1.map(b => b.status));
  const r2seeded = tv.tournament.bracket.filter(b => b.round === 2 && (b.team_a || b.team_b));
  check('bye winners are placed into round 2', r2seeded.length === 2, r2seeded.map(b => [b.team_a, b.team_b]));

  /* play it out */
  let guard = 0;
  while (guard++ < 20) {
    tv = await get('/api/tournament?id=' + tid, { token: OT, ip: '10.0.0.1' });
    const next = tv.tournament.bracket.find(b => b.status === 'pending' && b.team_a && b.team_b);
    if (!next) break;
    const bad = await post('/api/admin/tournament/result', { token: OT, ip: '10.0.0.1', body: { match: next.id, winner: 999999 } });
    if (guard === 1) check('a winner that is not in the match is rejected', bad.status === 400, bad);
    await post('/api/admin/tournament/result', { token: OT, ip: '10.0.0.1', body: { match: next.id, winner: next.team_a, score_a: 16, score_b: 7 } });
  }
  tv = await get('/api/tournament?id=' + tid, { token: OT, ip: '10.0.0.1' });
  if (!tv.ok || !tv.tournament.bracket.length) console.log('DEBUG empty bracket:', JSON.stringify(tv).slice(0,400));
  const finalRound = Math.max(...tv.tournament.bracket.map(b => b.round));
  const final = tv.tournament.bracket.find(b => b.round === finalRound);
  check('the bracket plays through to a single winner', !!final.winner, final);
  check('tournament is marked completed', tv.tournament.status === 'completed', tv.tournament.status);

  /* 16-team bracket, no byes */
  const t2 = await post('/api/admin/tournament', { token: OT, ip: '10.0.0.1', body: { name: 'Full16', team_size: 1, max_teams: 16 } });
  await post('/api/admin/tournament/status', { token: OT, body: { id: t2.id, status: 'open' }, ip: '10.0.0.1' });
  for (let i = 0; i < 16; i++) {
    const reg = await post('/api/register', { body: { username: 't16u' + i, password: 'bulkpass123', confirm: 'bulkpass123' }, ip: '10.3.0.' + i });
    await post('/api/tournament/register', { token: reg.token, body: { id: t2.id, team: 'T' + i }, ip: '10.3.0.' + i });
  }
  const gen2 = await post('/api/admin/tournament/bracket', { token: OT, body: { id: t2.id }, ip: '10.0.0.1' });
  check('16-team bracket has no byes and 4 rounds', gen2.ok && gen2.size === 16 && gen2.byes === 0 && gen2.rounds === 4, gen2);

  /* every team size is accepted */
  let sizesOk = true;
  for (const s of [1, 2, 3, 4, 5]) {
    const r = await post('/api/admin/tournament', { token: OT, ip: '10.0.0.1', body: { name: 'Size' + s, team_size: s, max_teams: 4 } });
    if (!r.ok) sizesOk = false;
  }
  check('team sizes 1v1 through 5v5 all accepted', sizesOk);

  /* ---------- moderation ---------- */
  const victim = await post('/api/register', { body: { username: 'badguy', password: 'badguypass1', confirm: 'badguypass1' }, ip: '203.0.113.7' });
  const vt = victim.token, vuid = victim.user.uid;

  const kick = await post('/api/admin/kick', { token: OT, body: { uid: vuid, reason: 'testing' }, ip: '10.0.0.1' });
  check('owner can kick', kick.ok, kick);
  const afterKick = await get('/api/me', { token: vt, ip: '203.0.113.7' });
  check('a kick is delivered to the player but does not log them out', afterKick.ok && afterKick.kicked && afterKick.kicked.reason === 'testing', afterKick.kicked);
  const kickAgain = await get('/api/me', { token: vt, ip: '203.0.113.7' });
  check('a kick is only delivered once', kickAgain.ok && !kickAgain.kicked, kickAgain.kicked);

  const ban = await post('/api/admin/ban', { token: OT, body: { uid: vuid, reason: 'cheating' }, ip: '10.0.0.1' });
  check('owner can ban an account', ban.ok, ban);
  const afterBan = await get('/api/me', { token: vt, ip: '203.0.113.7' });
  check('a banned account loses its session', afterBan.status === 403, afterBan);
  const banLogin = await post('/api/login', { body: { username: 'badguy', password: 'badguypass1' }, ip: '203.0.113.7' });
  check('a banned account cannot log back in', banLogin.status === 403 && /banned/i.test(banLogin.error), banLogin);
  const banSelf = await post('/api/admin/ban', { token: OT, body: { uid: 1, reason: 'oops' }, ip: '10.0.0.1' });
  check('the owner account cannot be banned', banSelf.status === 400, banSelf);
  await post('/api/admin/unban', { token: OT, body: { uid: vuid }, ip: '10.0.0.1' });
  const unbanned = await post('/api/login', { body: { username: 'badguy', password: 'badguypass1' }, ip: '203.0.113.7' });
  check('unban restores access', unbanned.ok, unbanned);

  /* IP moderation */
  const detail = await get('/api/admin/user?uid=' + vuid, { token: OT, ip: '10.0.0.1' });
  check('owner sees connection addresses for an account', detail.ok && detail.ips.some(i => i.ip === '203.0.113.7'), detail.ips);
  const leak = await get('/api/admin/user?uid=' + vuid, { token: PT, ip: '10.0.0.2' });
  check('a normal player cannot see anyone\'s address', leak.status === 403, leak);
  const profileLeak = JSON.stringify(await get('/api/me', { token: vt, ip: '203.0.113.7' }));
  check('an ordinary response carries no IP address', !profileLeak.includes('203.0.113.7'), profileLeak.slice(0, 120));

  /* alt detection: two accounts on one address */
  const alt = await post('/api/register', { body: { username: 'altguy', password: 'altguypass1', confirm: 'altguypass1' }, ip: '203.0.113.7' });
  const detail2 = await get('/api/admin/user?uid=' + vuid, { token: OT, ip: '10.0.0.1' });
  check('shared-address investigation finds the other account', detail2.alts.some(a => a.uid === alt.user.uid), detail2.alts);

  const ipb = await post('/api/admin/ipban', { token: OT, body: { cidr: '203.0.113.0/24', reason: 'ban evasion' }, ip: '10.0.0.1' });
  check('owner can ban an address range', ipb.ok && ipb.cidr === '203.0.113.0/24', ipb);
  const fromBanned = await post('/api/login', { body: { username: 'altguy', password: 'altguypass1' }, ip: '203.0.113.9' });
  check('a banned range is refused at the front door', fromBanned.status === 403, fromBanned);
  const fromElsewhere = await post('/api/login', { body: { username: 'altguy', password: 'altguypass1' }, ip: '198.51.100.4' });
  check('the same account still works from another network', fromElsewhere.ok, fromElsewhere);
  const selfLock = await post('/api/admin/ipban', { token: OT, body: { cidr: '10.0.0.0/8', reason: 'oops' }, ip: '10.0.0.1' });
  check('the owner is stopped from banning their own address', selfLock.status === 400, selfLock);
  const badCidr = await post('/api/admin/ipban', { token: OT, body: { cidr: 'not-an-ip' }, ip: '10.0.0.1' });
  check('an invalid range is rejected', badCidr.status === 400, badCidr);
  const bans = await get('/api/admin/ipbans', { token: OT, ip: '10.0.0.1' });
  await post('/api/admin/unipban', { token: OT, body: { id: bans.bans[0].id }, ip: '10.0.0.1' });
  const afterUnban = await post('/api/login', { body: { username: 'altguy', password: 'altguypass1' }, ip: '203.0.113.9' });
  check('lifting a range ban restores access', afterUnban.ok, afterUnban);

  /* ---------- messaging ---------- */
  const dm = await post('/api/admin/message', { token: OT, ip: '10.0.0.1', body: { uid: 2, subject: 'Hello', body: 'A private note' } });
  check('owner can send a private message', dm.ok, dm);
  const bc = await post('/api/admin/message', { token: OT, ip: '10.0.0.1', body: { broadcast: true, subject: 'Server news', body: 'Tournament on Friday' } });
  check('owner can send an announcement', bc.ok, bc);
  const inbox = await get('/api/inbox', { token: PT, ip: '10.0.0.2' });
  check('the message reaches the recipient inbox', inbox.ok && inbox.messages.some(m => m.subject === 'Hello'), inbox.messages?.length);
  check('the announcement reaches everyone', inbox.messages.some(m => m.subject === 'Server news'), inbox.messages?.length);
  const otherInbox = await get('/api/inbox', { token: tokens[2], ip: '10.0.1.2' });
  check('a private message does not reach other players', !otherInbox.messages.some(m => m.subject === 'Hello'), otherInbox.messages?.map(m => m.subject));
  const meUnread = await get('/api/me', { token: PT, ip: '10.0.0.2' });
  check('unread count is reported', meUnread.unread >= 2, meUnread.unread);
  await post('/api/inbox/read', { token: PT, body: { ids: inbox.messages.map(m => m.id) }, ip: '10.0.0.2' });
  const meRead = await get('/api/me', { token: PT, ip: '10.0.0.2' });
  check('marking as read clears the unread count', meRead.unread === 0, meRead.unread);
  const dmDeny = await post('/api/admin/message', { token: PT, ip: '10.0.0.2', body: { uid: 1, subject: 'x', body: 'y' } });
  check('a normal player cannot send announcements', dmDeny.status === 403, dmDeny);

  /* ---------- lobby chat ---------- */
  const say = await post('/api/chat/send', { token: PT, body: { body: 'hello everyone' }, ip: '10.0.0.2' });
  check('a signed-in player can post to chat', say.ok, say);
  const anonChat = await post('/api/chat/send', { body: { body: 'hi' }, ip: '10.0.0.99' });
  check('an anonymous visitor cannot post to chat', anonChat.status === 401, anonChat);
  const emptyChat = await post('/api/chat/send', { token: PT, body: { body: '   ' }, ip: '10.0.0.2' });
  check('an empty chat message is rejected', emptyChat.status === 400, emptyChat);
  await post('/api/chat/send', { token: OT, body: { body: 'owner speaking' }, ip: '10.0.0.1' });
  const feed = await get('/api/chat?since=0', { token: PT, ip: '10.0.0.2' });
  check('chat returns recent messages oldest first', feed.ok && feed.messages.length >= 2 &&
    feed.messages[feed.messages.length - 1].body === 'owner speaking', feed.messages?.map(m => m.body));
  check('chat marks which message came from the owner',
    feed.messages.find(m => m.body === 'owner speaking').owner === true &&
    feed.messages.find(m => m.body === 'hello everyone').owner === false, feed.messages?.map(m => [m.username, m.owner]));
  check('chat carries the UID of each speaker', feed.messages.every(m => typeof m.uid === 'number'), feed.messages?.[0]);
  check('chat reports who is online', Array.isArray(feed.online) && feed.online.some(u => u.uid === 1), feed.online);
  const longMsg = await post('/api/chat/send', { token: PT, body: { body: 'x'.repeat(5000) }, ip: '10.0.0.2' });
  const feed2 = await get('/api/chat?since=0', { token: PT, ip: '10.0.0.2' });
  check('an over-long chat message is truncated, not rejected',
    longMsg.ok && feed2.messages.some(m => m.body.length === 300), feed2.messages?.map(m => m.body.length));
  let chatLimited = false;
  for (let i = 0; i < 16; i++) {
    const r = await post('/api/chat/send', { token: PT, body: { body: 'spam ' + i }, ip: '10.0.0.2' });
    if (r.status === 429) { chatLimited = true; break; }
  }
  check('chat flooding is rate limited', chatLimited);
  const sinceFeed = await get('/api/chat?since=' + feed2.messages[feed2.messages.length - 1].id, { token: OT, ip: '10.0.0.1' });
  check('chat can be polled incrementally', sinceFeed.ok && sinceFeed.messages.every(m => m.id > feed2.messages[feed2.messages.length - 1].id), sinceFeed.messages?.length);
  const hideDeny = await post('/api/admin/chat/hide', { token: PT, body: { id: feed.messages[0].id }, ip: '10.0.0.2' });
  check('a normal player cannot hide a chat message', hideDeny.status === 403, hideDeny);
  await post('/api/admin/chat/hide', { token: OT, body: { id: feed.messages[0].id }, ip: '10.0.0.1' });
  const afterHide = await get('/api/chat?since=0', { token: PT, ip: '10.0.0.2' });
  check('the owner can hide a chat message', !afterHide.messages.some(m => m.id === feed.messages[0].id), afterHide.messages?.length);
  const bannedChat = await post('/api/chat/send', { token: vt, body: { body: 'let me in' }, ip: '203.0.113.7' });
  check('a banned account cannot post to chat', bannedChat.status === 403 || bannedChat.status === 401, bannedChat);

  /* ---------- audit ---------- */
  const audit = await get('/api/admin/audit', { token: OT, ip: '10.0.0.1' });
  const actions = audit.entries.map(e => e.action);
  check('admin actions are written to the audit log', ['ban', 'unban', 'kick', 'ip_ban', 'announce'].every(a => actions.includes(a)), actions.slice(0, 12));
  check('a refused admin attempt is logged too', actions.includes('admin_denied'), actions.slice(0, 20));
  check('the audit log holds no passwords', !JSON.stringify(audit.entries).match(/ownerpass1|badguypass1/), 'audit');

  /* ---------- rate limiting ---------- */
  let limited = false;
  for (let i = 0; i < 26; i++) {
    const r = await post('/api/login', { body: { username: 'nosuchuser', password: 'x'.repeat(10) }, ip: '192.0.2.50' });
    if (r.status === 429) { limited = true; break; }
  }
  check('login brute force is rate limited', limited);

  /* ---------- persistence ---------- */
  const uidBefore = db.prepare('SELECT MAX(uid) m FROM users').get().m;
  const reopened = require('./db').open(process.env.DB_FILE);
  check('the database reopens with accounts intact', reopened.prepare('SELECT COUNT(*) n FROM users').get().n > 10);
  check('bans survive a restart', reopened.prepare('SELECT COUNT(*) n FROM ip_bans').get().n >= 1);
  reopened.close();
  const after = await post('/api/register', { body: { username: 'afterall', password: 'afterpass12', confirm: 'afterpass12' }, ip: '198.51.100.77' });
  check('UIDs keep counting up and are never reused', after.user.uid === uidBefore + 1, [uidBefore, after.user.uid]);

  /* ---------- report channel ---------- */
  const rep = await post('/api/report', { token: PT, ip: '10.0.0.2', body: { about: vuid, kind: 'speed', detail: 'moved 40 u/s' } });
  check('a player can report a suspicious opponent', rep.ok, rep);
  const repList = await get('/api/admin/reports', { token: OT, ip: '10.0.0.1' });
  check('reports show up for the owner', repList.ok && repList.reports.some(r => r.kind === 'speed'), repList.reports?.length);

  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  server.close();
  try { db.close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('\n' + results.join('\n')); console.error('TEST CRASH', e); process.exit(2); });
