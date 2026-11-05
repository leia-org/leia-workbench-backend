import axios from 'axios';

const DEFAULT_REPO_OWNER = 'benjimrfl';
const DEFAULT_REPO_NAME = 'leia-design-pattern-escenarios';
const DEFAULT_REF = 'main';

function languageForPath(path) {
  return path.endsWith('.java') ? 'java' : 'text';
}

// Fetches every file under <pattern>/<scenarioNumber>/ from the scenario repo
// via jsDelivr. This must run server-side: the folder name IS the design
// pattern the exercise expects the student to find, so a direct browser
// request would leak the answer to anyone reading the Network tab. The
// student only ever talks to our own session-scoped endpoint, which returns
// file contents with no indication of which pattern or folder they came from.
class ScenarioRepoService {
  async fetchScenarioFiles(source, scenarioNumber) {
    const owner = source.repoOwner || DEFAULT_REPO_OWNER;
    const repo = source.repoName || DEFAULT_REPO_NAME;
    const ref = source.ref || DEFAULT_REF;
    const prefix = `/${source.pattern}/${scenarioNumber}/`;

    const listRes = await axios.get(
      `https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${ref}`,
      { params: { structure: 'flat' } },
    );
    const matchingPaths = (listRes.data.files || [])
      .map((f) => f.name)
      .filter((name) => name.startsWith(prefix));

    if (matchingPaths.length === 0) {
      const error = new Error('No scenario files found for the configured pattern/scenario');
      error.statusCode = 404;
      throw error;
    }

    const files = await Promise.all(
      matchingPaths.map(async (fullPath) => {
        const contentRes = await axios.get(
          `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}${fullPath}`,
          { responseType: 'text', transformResponse: (data) => data },
        );
        const path = fullPath.slice(prefix.length);
        return { path, language: languageForPath(path), content: contentRes.data };
      }),
    );

    // Flat structure (no subdirectories within a scenario) — alphabetical,
    // Main.java last since it's the natural entry point to read.
    return files.sort((a, b) => {
      if (a.path === 'Main.java') return 1;
      if (b.path === 'Main.java') return -1;
      return a.path.localeCompare(b.path);
    });
  }
}

export default new ScenarioRepoService();
