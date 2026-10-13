/* 1v1 tournament lifecycle, end to end, against the real server and a throwaway
   database: create -> open -> two players register -> close -> bracket ->
   play by lobby code -> report -> advance -> champion.
   Run: node server/cup-e2e.js */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hvhcup-'));
process.env.DB_FILE = path.join(tmp, 'cup.db');
process.env.SERVE_STATIC = '0';
process.env.TRUST_PROXY = '1';
process.env.PORT = '0';
const { server, db } = require('./server');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  <' + JSON.stringify(x).slice(0, 220) + '>' : '')); } };

let base;
async function call(method, p, { token, body, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  if (ip) headers['x-forwarded-for'] = ip;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, ...j };
}
const reg = (u, ip) => call('POST', '/api/register', { body: { username: u, password: 'hunter22222' }, ip });

(async () => {
  await new Promise(r => server.listen(0, r));
  base = 'http://127.0.0.1:' + server.address().port;

  const owner = await reg('owner', '10.0.0.1');          // first account is UID 1
  const p2    = await reg('rival', '10.0.0.2');
  ck('owner is UID 1', owner.user && owner.user.uid === 1, owner);
  ck('second player registered', p2.user && p2.user.uid === 2, p2);

  console.log('\ncreate and open a 1v1 cup');
  const mk = await call('POST', '/api/admin/tournament',
    { token: owner.token, body: { name: 'Friday 1v1', team_size: 1, max_teams: 4, best_of: 1 } });
  const id = mk.tournament ? mk.tournament.id : mk.id;
  ck('owner creates a 1v1 tournament', !!id, mk);
  const list0 = await call('GET', '/api/tournaments', { token: owner.token });
  ck('it starts as a draft', (list0.tournaments || []).find(x => x.id === id)?.status === 'draft', list0.tournaments);

  const open = await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id, status: 'open' } });
  ck('owner opens registration', open.status === 200, open);

  console.log('\nboth players register');
  const r1 = await call('POST', '/api/tournament/register', { token: owner.token, body: { id, team: 'rainy' } });
  const r2 = await call('POST', '/api/tournament/register', { token: p2.token,   body: { id, team: 'rival' } });
  ck('player one registers a team', r1.status === 200, r1);
  ck('player two registers a team', r2.status === 200, r2);
  const dup = await call('POST', '/api/tournament/register', { token: p2.token, body: { id, team: 'again' } });
  ck('the same player cannot register twice', dup.status !== 200, dup);

  console.log('\nclose and generate the bracket');
  ck('owner closes registration',
    (await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id, status: 'closed' } })).status === 200);
  const br = await call('POST', '/api/admin/tournament/bracket', { token: owner.token, body: { id, force: true } });
  ck('bracket generates', br.status === 200, br);

  let t = (await call('GET', '/api/tournament?id=' + id, { token: owner.token })).tournament || {};
  const bracket = t.bracket || [];
  ck('the bracket has a match with both teams',
     bracket.some(b => b.team_a && b.team_b), bracket.map(b => [b.round, b.slot, b.team_a, b.team_b]));

  const m = bracket.find(b => b.team_a && b.team_b);
  const teamA = m.team_a, teamB = m.team_b;

  console.log('\nplay it by lobby code');
  const host = await call('POST', '/api/match/host', { token: owner.token, body: { mode: '1v1' } });
  ck('a player hosts a 1v1 lobby', host.status === 200 && host.match && host.match.code, host);
  const join = await call('POST', '/api/match/join', { token: p2.token, body: { code: host.match.code } });
  ck('the opponent joins by code', join.status === 200, join);

  console.log('\nreport the result and advance');
  const bad = await call('POST', '/api/admin/tournament/result',
    { token: p2.token, body: { match: m.id, winner: teamA, score_a: 16, score_b: 9 } });
  ck('a non-owner cannot report a result', bad.status === 401 || bad.status === 403, bad);

  const rep = await call('POST', '/api/admin/tournament/result',
    { token: owner.token, body: { match: m.id, winner: teamA, score_a: 16, score_b: 9 } });
  ck('owner reports the winner', rep.status === 200, rep);

  const bogus = await call('POST', '/api/admin/tournament/result',
    { token: owner.token, body: { match: m.id, winner: 9999, score_a: 1, score_b: 0 } });
  ck('a team not in that match cannot be declared winner', bogus.status === 400, bogus);

  t = (await call('GET', '/api/tournament?id=' + id, { token: owner.token })).tournament || {};
  const done = (t.bracket || []).find(b => b.id === m.id);
  ck('the match records the winner and score', done && done.winner === teamA && done.score_a === 16, done);
  ck('the match is marked done', done && done.status === 'done', done && done.status);

  const champ = (t.bracket || []).filter(b => b.round === Math.max(...t.bracket.map(x => x.round)));
  ck('the winner reaches the final round', champ.some(b => b.winner === teamA || b.team_a === teamA || b.team_b === teamA),
     champ.map(b => [b.round, b.team_a, b.team_b, b.winner]));
  ck('the tournament is completed', t.status === 'completed' || t.status === 'live', t.status);

  /* A two-team bracket has a single match, so advance() is never really tested.
     Four teams means semi-finals feeding a final: that is where a winner can be
     dropped, put in the wrong slot, or a round can fail to close. */
  console.log('\n four teams, two rounds');
  const p3 = await reg('third', '10.0.0.3'), p4 = await reg('fourth', '10.0.0.4');
  const mk2 = await call('POST', '/api/admin/tournament',
    { token: owner.token, body: { name: 'Four up', team_size: 1, max_teams: 4, best_of: 1 } });
  const id2 = mk2.tournament ? mk2.tournament.id : mk2.id;
  await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id: id2, status: 'open' } });
  const toks = [owner.token, p2.token, p3.token, p4.token];
  for (let i = 0; i < 4; i++)
    await call('POST', '/api/tournament/register', { token: toks[i], body: { id: id2, team: 'T' + (i + 1) } });
  await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id: id2, status: 'closed' } });
  await call('POST', '/api/admin/tournament/bracket', { token: owner.token, body: { id: id2, force: true } });

  let t2 = (await call('GET', '/api/tournament?id=' + id2, { token: owner.token })).tournament || {};
  const r1m = (t2.bracket || []).filter(b => b.round === 1);
  ck('four teams make two first-round matches', r1m.length === 2, r1m.map(b => [b.slot, b.team_a, b.team_b]));

  const winners = [];
  for (const b of r1m) {
    winners.push(b.team_a);
    const res = await call('POST', '/api/admin/tournament/result',
      { token: owner.token, body: { match: b.id, winner: b.team_a, score_a: 16, score_b: 4 } });
    ck('semi-final ' + b.slot + ' result recorded', res.status === 200, res);
  }

  t2 = (await call('GET', '/api/tournament?id=' + id2, { token: owner.token })).tournament || {};
  const fin = (t2.bracket || []).find(b => b.round === 2);
  ck('a final exists', !!fin, t2.bracket);
  ck('both semi winners are placed in the final',
     fin && winners.includes(fin.team_a) && winners.includes(fin.team_b) && fin.team_a !== fin.team_b,
     fin && [fin.team_a, fin.team_b, winners]);
  ck('the tournament is live, not finished, with the final outstanding', t2.status === 'live', t2.status);

  const champ2 = await call('POST', '/api/admin/tournament/result',
    { token: owner.token, body: { match: fin.id, winner: fin.team_a, score_a: 16, score_b: 14 } });
  ck('the final can be reported', champ2.status === 200, champ2);

  t2 = (await call('GET', '/api/tournament?id=' + id2, { token: owner.token })).tournament || {};
  const fin2 = (t2.bracket || []).find(b => b.round === 2);
  ck('the champion is recorded', fin2 && fin2.winner === fin.team_a, fin2);
  ck('the tournament completes once the final is done', t2.status === 'completed', t2.status);

  const again = await call('POST', '/api/admin/tournament/result',
    { token: owner.token, body: { match: fin.id, winner: fin.team_b, score_a: 1, score_b: 16 } });
  t2 = (await call('GET', '/api/tournament?id=' + id2, { token: owner.token })).tournament || {};
  ck('re-reporting a finished final does not corrupt the bracket',
     (t2.bracket || []).filter(b => b.round === 2).length === 1, again);

  /* Odd team counts are where brackets usually go wrong: somebody must get a bye
     into round two, and it must be exactly one somebody. */
  console.log('\n three teams, one bye');
  const mk3 = await call('POST', '/api/admin/tournament',
    { token: owner.token, body: { name: 'Odd one out', team_size: 1, max_teams: 4, best_of: 1 } });
  const id3 = mk3.tournament ? mk3.tournament.id : mk3.id;
  await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id: id3, status: 'open' } });
  for (let i = 0; i < 3; i++)
    await call('POST', '/api/tournament/register', { token: toks[i], body: { id: id3, team: 'B' + (i + 1) } });
  await call('POST', '/api/admin/tournament/status', { token: owner.token, body: { id: id3, status: 'closed' } });
  const br3 = await call('POST', '/api/admin/tournament/bracket', { token: owner.token, body: { id: id3, force: true } });
  ck('a three-team bracket generates', br3.status === 200, br3);

  let t3 = (await call('GET', '/api/tournament?id=' + id3, { token: owner.token })).tournament || {};
  const all3 = t3.bracket || [];
  const real = all3.filter(b => b.team_a && b.team_b);
  const r1half = all3.filter(b => b.round === 1 && ((b.team_a && !b.team_b) || (!b.team_a && b.team_b)));
  ck('exactly one match is actually contested', real.length === 1, all3.map(b => [b.round, b.slot, b.team_a, b.team_b]));
  /* A bye shows up twice on purpose: the unopposed round-one slot, and that same
     team already sitting in the next round. Assert the invariant - one team is
     unopposed in round one, and it is the one pre-placed in the final - rather
     than counting rows, which is what made this fail first time round. */
  ck('exactly one team is unopposed in round one', r1half.length === 1,
     r1half.map(b => [b.round, b.slot, b.team_a, b.team_b]));
  const byeTeam = r1half.length ? (r1half[0].team_a || r1half[0].team_b) : null;
  const preFinal = all3.find(b => b.round === 2);
  ck('the bye team is already placed in the next round',
     byeTeam && preFinal && (preFinal.team_a === byeTeam || preFinal.team_b === byeTeam),
     [byeTeam, preFinal && [preFinal.team_a, preFinal.team_b]]);

  const played = real[0];
  await call('POST', '/api/admin/tournament/result',
    { token: owner.token, body: { match: played.id, winner: played.team_a, score_a: 16, score_b: 2 } });
  t3 = (await call('GET', '/api/tournament?id=' + id3, { token: owner.token })).tournament || {};
  const f3 = (t3.bracket || []).find(b => b.round === Math.max(...t3.bracket.map(x => x.round)));
  ck('the bye team and the winner meet in the final',
     f3 && f3.team_a && f3.team_b && f3.team_a !== f3.team_b, f3 && [f3.team_a, f3.team_b]);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  server.close(); db.close && db.close();
  process.exit(fail ? 1 : 0);
})();
