import test from 'node:test';
import assert from 'node:assert/strict';
import {agentStatus, herdrSchema, herdrAgents, agentTool, mergeAgents, gitHeadBranch, gitDirFile, agentCollisions, waitingQueue} from '../model.js';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const status = fields => ({version: 1, id: 's1', tool: 'claude', state: 'working', cwd: '/w/a', pid: 100, updatedAt: '2030-01-01T11:59:00Z', ...fields});

test('status files are checked, capped and aged out', () => {
    const ok = agentStatus(status({state: 'waiting', waitingFor: 'permission', message: 'secret prompt'}), NOW);
    assert.equal(ok.state, 'waiting');
    assert.equal(ok.waitingFor, 'permission');
    assert.ok(!JSON.stringify(ok).includes('secret'));
    assert.equal(agentStatus(status({state: 'waiting', waitingFor: 'Please approve rm -rf'}), NOW).waitingFor, 'unknown');
    assert.equal(agentStatus(status({version: 2}), NOW), null);
    assert.equal(agentStatus(status({state: 'dancing'}), NOW), null);
    assert.equal(agentStatus(status({updatedAt: '2029-12-31T20:00:00Z'}), NOW), null);
    assert.equal(agentStatus(status({name: 'x'.repeat(500)}), NOW).name.length, 120);
    assert.equal(agentStatus(status({name: 'a\u0007b<i>'}), NOW).name, 'ab<i>');
    assert.equal(agentStatus(status({pid: 1}), NOW).pid, null);
});

test('herdr schema and snapshot', () => {
    assert.deepEqual(herdrSchema('Herdr API schema\nprotocol: 22\nschema_version: 1\n'), {protocol: 22, schema: 1});
    assert.equal(herdrSchema('garbage'), null);
    const agents = herdrAgents({result: {type: 'session_snapshot', snapshot: {agents: [
        {pane_id: 'p1', agent: 'claude', agent_status: 'blocked', cwd: '/w/a', title: 'secret title', terminal_title: 'secret'},
        {pane_id: 'p2', agent: 'codex', agent_status: 'working', foreground_cwd: '/w/b'},
        {agent: 'no pane'},
    ]}}}, NOW);
    assert.equal(agents.length, 2);
    assert.deepEqual(agents.map(a => [a.state, a.cwd, a.pane]), [['waiting', '/w/a', 'p1'], ['working', '/w/b', 'p2']]);
    assert.ok(!JSON.stringify(agents).includes('secret'));
    assert.equal(herdrAgents({error: {code: 'server_not_running'}}), null);
});

test('agent CLIs match on argv[0] or argv[1] basename', () => {
    const known = ['claude', 'codex', 'opencode'];
    assert.equal(agentTool('/home/u/.local/bin/claude\0--resume', known), 'claude');
    assert.equal(agentTool('node\0/usr/lib/node_modules/codex/bin/codex.js\0', known), 'codex');
    assert.equal(agentTool('/usr/bin/vim\0claude.txt', known), null);
    assert.equal(agentTool('', known), null);
});

test('merge joins by pid and keeps the most exact state', () => {
    const merged = mergeAgents([
        [{source: 'process', id: 'p100', tool: 'claude', pid: 100, cwd: '/w/a', state: 'running'}],
        [{source: 'claude', id: 's1', tool: 'claude', pid: 100, cwd: '/w/a', state: 'idle', exact: false}],
        [agentStatus(status({state: 'waiting'}), NOW)],
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].state, 'waiting');
    assert.deepEqual([...merged[0].sources].sort(), ['claude', 'process', 'status']);
});

test('two agents in the same worktree stay two agents', () => {
    const merged = mergeAgents([
        [{source: 'claude', id: 'a', tool: 'claude', pid: 100, cwd: '/w/a', state: 'working'},
            {source: 'claude', id: 'b', tool: 'claude', pid: 200, cwd: '/w/a', state: 'working'}],
        // Herdr has no pid: with two candidates in that folder it must not join either.
        [{source: 'herdr', id: 'herdr:p1', tool: 'claude', pid: null, cwd: '/w/a', state: 'waiting', pane: 'p1'}],
    ]);
    assert.equal(merged.length, 3);
});

test('herdr joins a pid source when exactly one candidate fits, and lends its pane', () => {
    const merged = mergeAgents([
        [{source: 'process', id: 'p300', tool: 'codex', pid: 300, cwd: '/w/b', state: 'running'}],
        [{source: 'herdr', id: 'herdr:p2', tool: 'codex', pid: null, cwd: '/w/b', state: 'working', pane: 'p2'}],
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual([merged[0].state, merged[0].pid, merged[0].pane], ['working', 300, 'p2']);
});

test('git HEAD and worktree files', () => {
    assert.equal(gitHeadBranch('ref: refs/heads/feature/x\n'), 'feature/x');
    assert.equal(gitHeadBranch('0123456789abcdef0123456789abcdef01234567'), '0123456');
    assert.equal(gitHeadBranch('nonsense'), null);
    assert.equal(gitDirFile('gitdir: /w/repo/.git/worktrees/b\n'), '/w/repo/.git/worktrees/b');
});

test('collisions count working and waiting agents per tree; queue is oldest first', () => {
    const agents = [
        {tree: '/w/a', state: 'working', since: 3}, {tree: '/w/a', state: 'waiting', since: 2},
        {tree: '/w/b', state: 'working', since: 1}, {tree: '/w/b', state: 'idle', since: 1},
        {tree: '/w/c', state: 'waiting', since: 1},
    ];
    assert.deepEqual([...agentCollisions(agents)], [['/w/a', 2]]);
    assert.deepEqual(waitingQueue(agents).map(a => a.tree), ['/w/c', '/w/a']);
});

test('herdr joins the hook\'s agent by session id, even from another folder', () => {
    const merged = mergeAgents([
        [{source: 'status', id: 'abc', tool: 'claude', pid: 100, cwd: '/w/repo', state: 'waiting', exact: true}],
        [{source: 'herdr', id: 'herdr:w1:p1', tool: 'claude', pid: null, cwd: '/home/u', state: 'idle', pane: 'w1:p1', session: 'abc'}],
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual([merged[0].state, merged[0].pane], ['waiting', 'w1:p1']);
});
