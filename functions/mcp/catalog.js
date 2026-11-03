'use strict';

// Official MCP servers TruX Code can connect to. The list is fixed on purpose: users cannot point the server
// at an arbitrary URL, because a server-side client that fetches user-supplied addresses can be aimed at the
// cloud metadata service or internal hosts. To add a server, add an entry here.
//
// Every endpoint below is a remote server over Streamable HTTP, taken from the vendor's own documentation:
//   GitHub            https://github.com/github/github-mcp-server
//   Google Workspace  https://developers.google.com/workspace/guides/configure-mcp-servers
//   Developer Knowledge  https://developers.google.com/knowledge/mcp
//
// Local (stdio) servers such as filesystem, git, Chrome DevTools, Flutter or the Firebase CLI are not listed:
// they are meant to run on a developer's own machine, and on a shared Cloud Run service they would operate on
// the server's disk instead of the user's project.

const G = 'https://www.googleapis.com/auth/';
const g = (...names) => names.map((name) => G + name);

const WORKSPACE_NOTE =
  'Needs the Google OAuth client configured for this deployment and Google Workspace Developer Preview access.';

const CATALOG = Object.freeze([
  {
    id: 'github',
    name: 'GitHub',
    group: 'Code',
    description: 'Browse repositories, read code, search issues and pull requests. Official GitHub MCP server.',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: {
      type: 'token',
      label: 'GitHub personal access token',
      header: 'Authorization',
      prefix: 'Bearer ',
      help: 'Create a fine-grained token at github.com/settings/personal-access-tokens and give it only the repositories and permissions you want TruX Code to use.'
    }
  },
  {
    id: 'developer-knowledge',
    name: 'Google Developer Knowledge',
    group: 'Code',
    description: 'Search and read official Google developer documentation (Firebase, Cloud, Android, Maps and more).',
    url: 'https://developerknowledge.googleapis.com/mcp',
    auth: {
      type: 'apikey',
      label: 'Google API key',
      header: 'X-Goog-Api-Key',
      prefix: '',
      // When the deployment sets this variable, nobody has to paste a key.
      serverEnv: 'DEVELOPER_KNOWLEDGE_API_KEY',
      help: 'An API key with the Developer Knowledge API enabled in your Google Cloud project.'
    },
    readOnly: true
  },
  {
    id: 'gmail',
    name: 'Gmail',
    group: 'Google Workspace',
    description: 'Search and read mail, and create drafts.',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('gmail.readonly', 'gmail.compose') },
    note: WORKSPACE_NOTE
  },
  {
    id: 'drive',
    name: 'Google Drive',
    group: 'Google Workspace',
    description: 'Find and read files in Drive.',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('drive.readonly', 'drive.file') },
    note: WORKSPACE_NOTE
  },
  {
    id: 'docs',
    name: 'Google Docs',
    group: 'Google Workspace',
    description: 'Read and edit Google Docs.',
    url: 'https://docsmcp.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('drive.readonly', 'drive.file', 'documents.readonly', 'documents') },
    note: WORKSPACE_NOTE
  },
  {
    id: 'sheets',
    name: 'Google Sheets',
    group: 'Google Workspace',
    description: 'Read and edit spreadsheets.',
    url: 'https://sheetsmcp.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('drive.readonly', 'drive.file', 'spreadsheets.readonly', 'spreadsheets') },
    note: WORKSPACE_NOTE
  },
  {
    id: 'slides',
    name: 'Google Slides',
    group: 'Google Workspace',
    description: 'Read and edit presentations.',
    url: 'https://slidesmcp.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('drive.readonly', 'drive.file', 'presentations.readonly', 'presentations') },
    note: WORKSPACE_NOTE
  },
  {
    id: 'calendar',
    name: 'Google Calendar',
    group: 'Google Workspace',
    description: 'See your calendars, events and free/busy time.',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: {
      type: 'google',
      scopes: g('calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events.readonly')
    },
    note: WORKSPACE_NOTE
  },
  {
    id: 'people',
    name: 'Google People',
    group: 'Google Workspace',
    description: 'Look up contacts and your directory.',
    url: 'https://people.googleapis.com/mcp/v1',
    auth: { type: 'google', scopes: g('directory.readonly', 'userinfo.profile', 'contacts.readonly') },
    note: WORKSPACE_NOTE
  }
]);

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

function getEntry(id) {
  return BY_ID.get(String(id || '').trim().toLowerCase()) || null;
}

module.exports = { CATALOG, getEntry };
