import { createHash } from 'node:crypto';

export const gitBlobHash = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
export function shareRemoteFixture(initial = {}) {
  let serial = 1;
  const sha = () => String(serial++).padStart(40, '0');
  const blobs = new Map(), trees = new Map(), commits = new Map(), calls = [];
  const put = value => { const bytes = Buffer.from(value), hash = gitBlobHash(bytes); blobs.set(hash, bytes); return hash; };
  const tree = sha(); trees.set(tree, new Map(Object.entries(initial).map(([path, value]) => [path, put(value)])));
  let head = sha(); commits.set(head, tree);
  const fixture = { calls, truncated: false, offline: false, loseResponse: false, mode: '100644',
    get head() { return head; },
    get files() { return new Map([...trees.get(commits.get(head))].map(([path, hash]) => [path, blobs.get(hash)])); },
    advance() { const next = sha(); commits.set(next, commits.get(head)); head = next; },
    async request(path, method = 'GET', body) {
      calls.push({ path, method, body });
      const relative = path.replace(/^\/?repos\/[^/]+\/[^/]+/, '').split('?')[0];
      if (relative === '') return { private: false, permissions: { push: true }, default_branch: 'main' };
      if (relative === '/git/ref/heads/main') return { object: { sha: head } };
      if (relative.startsWith('/git/commits/') && method === 'GET') return { tree: { sha: commits.get(relative.split('/').pop()) } };
      if (relative.startsWith('/git/trees/') && method === 'GET') return { truncated: fixture.truncated, tree: [...trees.get(relative.split('/').pop())].map(([path, sha]) => ({ path, sha, type: 'blob', mode: path === 'publish-state.json' ? fixture.mode : '100644' })) };
      if (relative.startsWith('/git/blobs/') && method === 'GET') return { encoding: 'base64', content: blobs.get(relative.split('/').pop()).toString('base64') };
      if (relative === '/git/blobs') return { sha: put(Buffer.from(body.content, 'base64')) };
      if (relative === '/git/trees') {
        const entries = new Map(trees.get(body.base_tree));
        for (const entry of body.tree) if (entry.sha === null) entries.delete(entry.path); else entries.set(entry.path, entry.sha);
        const hash = sha(); trees.set(hash, entries); return { sha: hash };
      }
      if (relative === '/git/commits') { const hash = sha(); commits.set(hash, body.tree); return { sha: hash }; }
      if (relative === '/git/refs/heads/main') {
        if (body.force !== false) throw Error('Unexpected forced update');
        if (fixture.offline) throw Error('offline');
        head = body.sha;
        if (fixture.loseResponse) { fixture.loseResponse = false; throw Error('lost response'); }
        return { object: { sha: head } };
      }
      if (relative === '/pages') return { html_url: 'https://test.github.io/public/', source: { branch: 'main', path: '/' }, build_type: 'legacy' };
      if (relative === '/pages/builds/latest') return { commit: head, status: 'built' };
      throw Error(`Unexpected request ${method} ${path}`);
    }
  };
  return fixture;
}
