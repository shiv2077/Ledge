import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Module} from '../lib/module.js';
import {run} from '../lib/subprocess.js';
import {parseRepos, pullRequests, ciState, isGithubUrl} from '../model.js';
import {MODULE_COLORS} from '../design.js';

const PR_FIELDS = 'number,title,url,repository';
const RUN_FIELDS = 'status,conclusion,name,displayTitle,url,headBranch,workflowName';
const GH_TIMEOUT = 30;
const GH_AUTH_REQUIRED = 4;
const MAX_REPOS = 10;
const MAX_PRS = 20;
const SIGTERM = 15;

// All GitHub access goes through the gh CLI, which owns authentication.
export class GithubModule extends Module {
    static id = 'github';
    static title = 'GitHub';

    start() {
        this._state = null;
        this._poll();
        this._schedule();
        this._settingsSignal = this.settings.connect('changed', (_s, key) => {
            if (key === 'github-poll-seconds') this._schedule();
            if (key === 'github-repos') this._poll();
        });
    }

    _schedule() {
        this._timer = this.clearTimer(this._timer);
        this._timer = this.every(this.settings.get_int('github-poll-seconds'), () => this._poll());
    }

    async _gh(args) {
        const r = await run(['gh', ...args], {timeout: GH_TIMEOUT, signal: SIGTERM, cancellable: this.cancellable, stderr: true});
        if (r.ok) {
            try { return {data: JSON.parse(r.stdout)}; } catch { return {error: 'gh returned unreadable output.'}; }
        }
        if (r.error?.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT))
            return {error: 'GitHub CLI (gh) is not installed.', fatal: true};
        // Killed by the timeout: no exit status and no spawn error.
        if (r.status === -1 && !r.error) return {error: 'gh did not answer in time.'};
        if (r.status === GH_AUTH_REQUIRED || /gh auth login/.test(r.stderr))
            return {error: 'gh is not logged in. Run gh auth login in a terminal.', fatal: true};
        return {error: `gh failed: ${r.stderr.split('\n').find(Boolean) ?? `exit ${r.status}`}`.slice(0, 200)};
    }

    async _poll() {
        if (this._polling) return;
        this._polling = true;
        const repos = parseRepos(this.settings.get_strv('github-repos').join(' ')).slice(0, MAX_REPOS);
        const reviews = await this._gh(['search', 'prs', '--review-requested=@me', '--state=open', '--json', PR_FIELDS, '--limit', String(MAX_PRS)]);
        let state;
        if (reviews.fatal) {
            state = {error: reviews.error, fatal: true, reviews: [], mine: [], runs: []};
        } else {
            const [mine, ...runs] = await Promise.all([
                this._gh(['search', 'prs', '--author=@me', '--state=open', '--json', PR_FIELDS, '--limit', String(MAX_PRS)]),
                ...repos.map(repo => this._gh(['run', 'list', '-R', repo, '--limit', '1', '--json', RUN_FIELDS])),
            ]);
            state = {
                error: reviews.error ?? mine.error ?? '',
                reviews: pullRequests(reviews.data), mine: pullRequests(mine.data),
                runs: repos.map((repo, i) => {
                    const latest = Array.isArray(runs[i].data) ? runs[i].data[0] : null;
                    return {repo, error: runs[i].error ?? '', state: ciState(latest),
                        title: String(latest?.workflowName || latest?.name || '').slice(0, 100),
                        branch: String(latest?.headBranch || '').slice(0, 100),
                        url: isGithubUrl(latest?.url) ? latest.url : `https://github.com/${repo}/actions`};
                }),
            };
        }
        this._polling = false;
        if (this.cancellable.is_cancelled()) return;
        this._state = state;
        this.changed();
    }

    _open(url) {
        if (!isGithubUrl(url)) return;
        Gio.AppInfo.launch_default_for_uri_async(url, null, this.cancellable, (_o, result) => {
            try { Gio.AppInfo.launch_default_for_uri_finish(result); } catch { /* No browser; nothing to show. */ }
        });
    }

    cell() {
        const s = this._state;
        const failed = s?.runs.some(r => r.state === 'failed');
        return {...super.cell(), icon: 'events-merge-symbolic',
            accent: failed ? 'critical' : MODULE_COLORS.github, fraction: failed ? 1 : null,
            label: s && !s.fatal ? String(s.reviews.length) : '—',
            stale: !s || Boolean(s.error),
            accessibleName: `GitHub: ${!s ? 'loading' : s.fatal ? s.error : `${s.reviews.length} review requests${failed ? ', CI failing' : ''}`}`};
    }

    card(body, ui) {
        const s = this._state;
        if (!s) {
            body.add_child(ui.label('Asking gh…', 'ledge-muted'));
            return [];
        }
        if (s.error) body.add_child(ui.label(s.error, 'ledge-warning'));
        const prs = (heading, list, empty) => {
            body.add_child(ui.label(heading, 'ledge-section'));
            if (!list.length) body.add_child(ui.label(empty, 'ledge-muted'));
            for (const pr of list.slice(0, 6))
                body.add_child(ui.row(pr.title, {detail: `${pr.repo} #${pr.number}`, onClick: () => this._open(pr.url)}));
            if (list.length > 6) body.add_child(ui.label(`and ${list.length - 6} more`, 'ledge-muted'));
        };
        prs('Review requested', s.reviews, 'No reviews waiting.');
        prs('Your pull requests', s.mine, 'No open pull requests.');
        body.add_child(ui.label('CI', 'ledge-section'));
        if (!s.runs.length) body.add_child(ui.label('Add repositories to watch in Settings.', 'ledge-muted'));
        for (const r of s.runs) {
            const detail = r.error || [r.title, r.branch, r.state === 'none' ? 'no runs' : r.state].filter(Boolean).join(' · ');
            body.add_child(ui.row(r.repo, {detail, onClick: () => this._open(r.url)}));
        }
        return [['Refresh', () => this._poll()]];
    }

    stop() {
        if (this._settingsSignal) this.settings.disconnect(this._settingsSignal);
        this._settingsSignal = 0;
        super.stop();
    }
}
