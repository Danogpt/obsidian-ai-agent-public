# Obsidian AI Agent Plugin

## Ziel

Dieses Projekt baut eine rechte Sidebar in Obsidian, ähnlich wie Claude Code oder Codex in Visual Studio Code. In dieser Sidebar kann der Nutzer mit einem KI-Agenten chatten. Der Agent kann optional auf den Obsidian Vault zugreifen, die aktuelle Notiz lesen, Markdown-Dateien suchen, neue Dateien erstellen und später Änderungen als Diff vorschlagen.

Der Nutzer bringt eigene API Keys mit. Das System nutzt also BYOK: Bring Your Own Key.

## Grundidee

```text
Obsidian Plugin
  -> Sidebar UI
  -> aktuelle Datei lesen
  -> Vault-Dateien suchen
  -> Änderungs-Diffs anzeigen
  -> Requests an lokales Backend senden

Local Backend
  -> API Keys aus .env lesen
  -> OpenAI Wrapper
  -> Anthropic / Claude Wrapper
  -> optional Websearch Tool
  -> Agent-Loop
  -> Antwort an Plugin zurückgeben
```

## Programmiersprachen

### 1. Obsidian Plugin

Sprache: TypeScript

Grund: Obsidian Plugins werden offiziell mit TypeScript/JavaScript gebaut. Das Plugin läuft direkt in Obsidian und kümmert sich um UI, Sidebar, Commands und Zugriff auf den Vault.

### 2. Local Backend

Sprache: Python mit FastAPI

Grund: Für Agentenlogik, API Wrapper, Websearch, Logging und spätere Tool-Loops ist ein lokales Backend sauberer. API Keys liegen dann in einer `.env` und nicht direkt im Obsidian Vault.

### 3. Optional später

* Node.js statt Python, falls alles in TypeScript bleiben soll
* PHP Backend, falls es in ein bestehendes AssetDepth/Server-System integriert werden soll
* Ollama/local models als zusätzlicher Provider

## Warum Backend statt API Calls direkt im Plugin?

Direkte API Calls aus dem Plugin wären für einen ersten Test möglich, aber langfristig schlechter:

* API Keys wären näher am Vault/Plugin gespeichert
* Websearch und Agent-Loop werden im Plugin schnell unübersichtlich
* Python Backend lässt sich besser testen
* Logging, Kostenkontrolle und Rate Limits sind einfacher
* Später kann dieselbe Agent-Logik auch von einer Website oder anderen Tools genutzt werden

## MVP Umfang

Version 1 soll bewusst klein bleiben:

```text
MVP 1
- Obsidian Plugin mit rechter Sidebar
- Chat-Eingabefeld
- Provider-Auswahl: OpenAI oder Claude
- Backend-URL in Settings
- aktuelle aktive Markdown-Datei als Kontext senden
- Antwort vom Backend anzeigen
```

Noch nicht im MVP:

```text
- komplette Vault-Suche
- Dateiänderungen
- Diff-Apply-System
- Websearch
- Autonomer Agent-Loop
- Multi-File-Editing
```

Diese Funktionen kommen danach stufenweise.

## Zielarchitektur

```text
obsidian-ai-agent/
├── plugin/
│   ├── manifest.json
│   ├── package.json
│   ├── esbuild.config.mjs
│   ├── src/
│   │   ├── main.ts
│   │   ├── settings.ts
│   │   ├── views/
│   │   │   └── AgentView.ts
│   │   ├── client/
│   │   │   └── backendClient.ts
│   │   └── styles.css
│   └── README_PLUGIN.md
│
├── backend/
│   ├── app.py
│   ├── requirements.txt
│   ├── .env.example
│   ├── providers/
│   │   ├── openai_provider.py
│   │   └── anthropic_provider.py
│   ├── agent/
│   │   ├── prompts.py
│   │   └── schemas.py
│   └── tools/
│       ├── web_search.py
│       └── vault_tools.py
│
└── README.md
```

## Datenfluss im MVP

```text
1. Nutzer schreibt Frage in Obsidian Sidebar
2. Plugin liest aktive Markdown-Datei
3. Plugin sendet Request an http://127.0.0.1:8765/chat
4. Backend liest Provider, Modell und API Key
5. Backend ruft OpenAI oder Claude auf
6. Backend gibt Antwort zurück
7. Plugin rendert Antwort in der Sidebar
```

## Beispiel Request vom Plugin an Backend

```json
{
  "provider": "openai",
  "model": "gpt-5.5",
  "message": "Fasse die aktuelle Notiz zusammen und erstelle Verbesserungsvorschläge.",
  "active_file": "idee/app-konzept.md",
  "active_file_content": "# App Konzept\n...",
  "options": {
    "web_search": false,
    "thinking_mode": false,
    "vault_context": true
  }
}
```

## Beispiel Response vom Backend

```json
{
  "answer": "Die Notiz beschreibt eine Hiking-App mit KI-gestützter Planung. Die Struktur ist sinnvoll, aber es fehlen noch klare MVP-Grenzen...",
  "sources": [
    "idee/app-konzept.md"
  ],
  "proposed_changes": []
}
```

## Plugin Features

### Rechte Sidebar

Die Sidebar enthält:

```text
- Chat-Verlauf
- Textarea für Eingabe
- Send Button
- Provider Dropdown
- Model Input
- Toggle: aktuelle Notiz als Kontext
- Toggle: Websearch
- Toggle: Thinking Mode
```

### Settings

Die Plugin Settings enthalten:

```text
- Backend URL
- Default Provider
- Default Model OpenAI
- Default Model Claude
- Toggle: aktive Notiz automatisch senden
```

API Keys werden im empfohlenen Setup nicht im Plugin gespeichert, sondern im Backend über `.env`.

## Backend Features

### API Endpoints

```text
GET /health
POST /chat
```

Später zusätzlich:

```text
POST /web-search
POST /vault/search
POST /vault/read
POST /agent/run
```

### Provider Wrapper

Das Backend bekommt eine einheitliche interne Funktion:

```python
chat_with_model(
    provider="openai",
    model="gpt-5.5",
    messages=[...],
    options={...}
)
```

Intern wird daraus je nach Provider ein OpenAI- oder Anthropic-API-Call.

## Entwicklungsphasen

### Phase 1: Plugin Skeleton

Ziel: Plugin erscheint in Obsidian und kann rechts geöffnet werden.

Aufgaben:

```text
- Obsidian Sample Plugin clonen
- TypeScript Build testen
- manifest.json anpassen
- rechte Sidebar View registrieren
- Command "Open AI Agent" hinzufügen
```

### Phase 2: Backend Skeleton

Ziel: Lokaler Server läuft und antwortet auf `/health` und `/chat`.

Aufgaben:

```text
- FastAPI installieren
- .env laden
- /health Endpoint bauen
- /chat Endpoint bauen
- Dummy-Antwort zurückgeben
```

### Phase 3: Plugin mit Backend verbinden

Ziel: Nachricht aus Obsidian geht an Backend und Antwort erscheint in Sidebar.

Aufgaben:

```text
- backendClient.ts bauen
- Fetch Request an Backend senden
- Ladezustand anzeigen
- Error Handling einbauen
```

### Phase 4: OpenAI Provider

Ziel: Echte Antwort von OpenAI.

Aufgaben:

```text
- OPENAI_API_KEY aus .env lesen
- OpenAI Client einbauen
- System Prompt definieren
- aktive Notiz als Kontext senden
```

### Phase 5: Claude Provider

Ziel: Umschaltbar zwischen OpenAI und Claude.

Aufgaben:

```text
- ANTHROPIC_API_KEY aus .env lesen
- Anthropic Client einbauen
- gemeinsames Antwortformat definieren
```

### Phase 6: Vault Tools

Ziel: Agent kann Vault-Inhalte nutzen.

Aufgaben:

```text
- zunächst aktive Datei senden
- danach Dateiliste aus Plugin senden
- einfache Suchfunktion über Dateinamen
- später Full-Text-Suche und Embeddings
```

### Phase 7: Websearch

Ziel: Optional Websearch aktivieren.

Aufgaben:

```text
- Toggle im Plugin
- Backend Tool web_search(query)
- Ergebnisse mit Quelle an Modell geben
- Antworten mit Quellen anzeigen
```

### Phase 8: Diff und Apply

Ziel: Agent schlägt Änderungen vor, überschreibt aber nichts direkt.

Aufgaben:

```text
- Backend gibt proposed_changes zurück
- Plugin zeigt Diff
- Nutzer klickt Apply
- Plugin schreibt erst dann in Vault
```

## Sicherheitsregeln

Der Agent darf am Anfang nur lesen.

```text
Mode 1: Read Only
- aktuelle Datei lesen
- Kontext analysieren
- Antwort geben

Mode 2: Suggest
- Änderungsvorschläge erzeugen
- Diff anzeigen
- keine direkte Änderung

Mode 3: Agent Mode
- Dateien erstellen oder ändern
- aber nur mit Nutzerbestätigung
```

Niemals direkt `modify()` ohne Bestätigung ausführen.

## Installation für Entwicklung

### Voraussetzungen

```text
- Node.js
- npm
- Python 3.11+
- Obsidian Desktop
- Visual Studio Code
```

### Plugin Setup

```bash
mkdir obsidian-ai-agent
cd obsidian-ai-agent

git clone https://github.com/obsidianmd/obsidian-sample-plugin.git plugin
cd plugin
npm install
npm run dev
```

Danach im Vault:

```text
Vault/.obsidian/plugins/obsidian-ai-agent/
```

Dort müssen später liegen:

```text
main.js
manifest.json
styles.css
```

### Backend Setup

```bash
cd ../
mkdir backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install fastapi uvicorn python-dotenv openai anthropic
```

`requirements.txt`:

```txt
fastapi
uvicorn
python-dotenv
openai
anthropic
pydantic
```

`.env.example`:

```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_MODEL=gpt-5.5
ANTHROPIC_MODEL=claude-sonnet-4-5
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8765
```

Backend starten:

```bash
uvicorn app:app --host 127.0.0.1 --port 8765 --reload
```

Health Check:

```text
http://127.0.0.1:8765/health
```

## Erste konkrete Dateien

### backend/app.py

```python
import os
from typing import Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Obsidian AI Agent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["app://obsidian.md", "http://localhost", "http://127.0.0.1"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatOptions(BaseModel):
    web_search: bool = False
    thinking_mode: bool = False
    vault_context: bool = True

class ChatRequest(BaseModel):
    provider: Literal["openai", "anthropic"] = "openai"
    model: Optional[str] = None
    message: str
    active_file: Optional[str] = None
    active_file_content: Optional[str] = None
    options: ChatOptions = ChatOptions()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/chat")
def chat(req: ChatRequest):
    context = ""
    if req.active_file and req.active_file_content:
        context = f"\n\nAktive Datei: {req.active_file}\n\n{req.active_file_content[:12000]}"

    return {
        "answer": f"Backend läuft. Provider: {req.provider}. Nachricht: {req.message}{context[:500]}",
        "sources": [req.active_file] if req.active_file else [],
        "proposed_changes": []
    }
```

### plugin/src/client/backendClient.ts

```ts
export type ChatRequestPayload = {
  provider: "openai" | "anthropic";
  model?: string;
  message: string;
  active_file?: string | null;
  active_file_content?: string | null;
  options: {
    web_search: boolean;
    thinking_mode: boolean;
    vault_context: boolean;
  };
};

export type ChatResponsePayload = {
  answer: string;
  sources?: string[];
  proposed_changes?: unknown[];
};

export async function sendChatRequest(
  backendUrl: string,
  payload: ChatRequestPayload
): Promise<ChatResponsePayload> {
  const response = await fetch(`${backendUrl.replace(/\/$/, "")}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Backend error ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}
```

## Offene technische Entscheidungen

### Websearch

Für den Start nicht direkt provider-native bauen. Besser ein eigenes Websearch Tool im Backend:

```text
web_search(query) -> results[]
```

Später kann dieses Tool intern OpenAI Websearch, Claude Websearch, Tavily, Brave Search oder eine andere Quelle nutzen.

### Vault Search

Für den Start reicht:

```text
- aktive Datei
- manuell ausgewählter Ordner
- Dateiname-Suche
```

Später:

```text
- Full-text Index
- Embeddings
- BM25/Fuzzy Search
- Kontext nach Relevanz und Tokenlimit
```

### Dateiänderungen

Nie direkt schreiben. Immer:

```text
Agent -> proposed_changes -> Diff UI -> Apply Button -> Vault modify
```

## Definition of Done für MVP 1

MVP 1 ist fertig, wenn:

```text
- Plugin in Obsidian geladen wird
- rechte Sidebar geöffnet werden kann
- Nutzer eine Nachricht senden kann
- aktive Datei optional mitgesendet wird
- Backend antwortet
- Antwort in Sidebar angezeigt wird
- Backend URL in Settings änderbar ist
```

## Nächster Schritt

Als nächstes wird das Plugin Skeleton aufgebaut:

```text
1. Sample Plugin clonen
2. manifest.json anpassen
3. main.ts vereinfachen
4. AgentView.ts erstellen
5. Settings Tab erstellen
6. Backend Dummy Endpoint testen
```
