import { Braces, Code2, MessageSquareCode, Monitor, Terminal } from 'lucide-react';
import { useState } from 'react';
import { connectionSnippets, defaultModel, exampleKey, exampleModels, sampleRequest } from '../lib/setup';
import type { ModelOption, Protocol } from '../lib/store';
import { usePreferences } from '../lib/preferences';
import { CodeBlock } from './CodeBlock';

const clients = [
  { id: 'codex', name: 'Codex', note: 'App / CLI / VS Code', icon: Monitor, file: '~/.codex/config.toml' },
  { id: 'claude', name: 'Claude Code', note: 'Anthropic Messages', icon: MessageSquareCode, file: '~/.claude/settings.json' },
  { id: 'opencode', name: 'OpenCode', note: 'OpenCode 2', icon: Code2, file: '~/.config/opencode/opencode.json' },
  { id: 'curl', name: 'curl', note: 'HTTP / SSE', icon: Terminal, file: 'Terminal' },
  { id: 'node', name: 'Node.js', note: 'OpenAI SDK', icon: Braces, file: 'index.ts' },
] as const;

const instructions = {
  codex: ['Добавьте настройки в пользовательский config.toml. Перед запуском Codex CLI, приложения или редактора сделайте переменную PROXYKEY_API_KEY доступной процессу.', 'Merge the settings into your user config.toml. Make PROXYKEY_API_KEY available to the CLI, desktop app, or editor before launching it.'],
  claude: ['Добавьте эти настройки в ~/.claude/settings.json и подставьте свой ключ ProxyKey. Затем запустите Claude Code.', 'Merge these settings into ~/.claude/settings.json and insert your ProxyKey API key. Then launch Claude Code.'],
  opencode: ['Добавьте настройки в пользовательский opencode.json. Запустите OpenCode 2 с переменной PROXYKEY_API_KEY и выберите модель через /models.', 'Merge the settings into your user opencode.json. Start OpenCode 2 with PROXYKEY_API_KEY and choose the model with /models.'],
  curl: ['Установите PROXYKEY_API_KEY и отправьте запрос.', 'Set PROXYKEY_API_KEY and send the request.'],
  node: ['Установите пакет openai в проект и передайте PROXYKEY_API_KEY процессу Node.js.', 'Install the openai package in your project and provide PROXYKEY_API_KEY to the Node.js process.'],
} as const;

function accepts(client: (typeof clients)[number]['id'], protocol: Protocol) {
  switch (client) {
    case 'codex': return protocol === 'OPENAI';
    case 'claude': return protocol === 'ANTHROPIC';
    case 'opencode': return protocol !== 'IMAGES';
    case 'node': return protocol !== 'ANTHROPIC' && protocol !== 'GEMINI';
    case 'curl': return true;
  }
}

export function ClientSetup({ models = [] }: { models?: ModelOption[] }) {
  const { locale } = usePreferences();
  const ru = locale === 'ru';
  const [active, setActive] = useState<(typeof clients)[number]['id']>('codex');
  const [system, setSystem] = useState<'posix' | 'powershell'>('posix');
  const [selectedModel, setSelectedModel] = useState('');
  const modelList = models.length ? models : exampleModels;
  const availableClients = clients.filter(({ id }) => modelList.some(({ protocol }) => accepts(id, protocol)));
  const client = availableClients.find(({ id }) => active === id) ?? availableClients[0]!;
  const choices = modelList.filter(({ protocol }) => accepts(client.id, protocol));
  const optionId = (choice: ModelOption) => `${choice.protocol}/${choice.model}`;
  const model = choices.find((choice) => optionId(choice) === selectedModel)
    ?? choices.find((choice) => choice.model === defaultModel) ?? choices[0]!;
  const snippets = connectionSnippets(window.location.origin, model.model, model.protocol);
  const exportKey = system === 'posix' ? `export PROXYKEY_API_KEY="${exampleKey}"` : `$env:PROXYKEY_API_KEY = "${exampleKey}"`;
  let code = snippets[client.id];
  if (client.id === 'curl' && system === 'powershell') {
    const { url, body, anthropic } = sampleRequest(window.location.origin, model);
    code = `@'\n${JSON.stringify(body)}\n'@ | curl.exe -N "${url}" \x60\n  -H "Authorization: Bearer $env:PROXYKEY_API_KEY" \x60\n  -H "Content-Type: application/json" ${anthropic ? '-H "anthropic-version: 2023-06-01" ' : ''}--data-binary '@-'`;
  }

  return <div className="client-setup">
    <div className="client-pickers" aria-label={ru ? 'Выберите приложение' : 'Choose a client'}>
      {availableClients.map(({ id, name, note, icon: Icon }) => <button key={id} type="button" onClick={() => setActive(id)} aria-pressed={id === client.id}>
        <Icon size={19}/><span><strong>{name}</strong><small>{note}</small></span>
      </button>)}
    </div>
    <div className="client-body">
      <div className="client-preferences">
        {client.id !== 'claude' && <label className="field"><span>{ru ? 'Оболочка' : 'Shell'}</span><select value={system} onChange={(event) => setSystem(event.target.value === 'powershell' ? 'powershell' : 'posix')}>
          <option value="posix">macOS / Linux</option><option value="powershell">Windows PowerShell</option>
        </select></label>}
        <label className="field"><span>{ru ? 'Модель' : 'Model'}</span><select value={optionId(model)} onChange={(event) => setSelectedModel(event.target.value)}>
          {choices.map((choice) => <option key={optionId(choice)} value={optionId(choice)}>{choice.model}</option>)}
        </select></label>
      </div>
      <p>{instructions[client.id][ru ? 0 : 1]}</p>
      {client.id !== 'claude' && <CodeBlock code={exportKey} label={ru ? 'Подставьте свой API-ключ' : 'Insert your API key'}/>}
      <CodeBlock code={code} label={client.file}/>
    </div>
  </div>;
}
