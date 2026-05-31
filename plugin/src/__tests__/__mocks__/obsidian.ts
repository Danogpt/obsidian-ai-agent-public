export class TFile {
	basename: string;
	extension = 'md';
	stat = null;
	vault = null;
	parent = null;

	constructor(public path: string, public name: string) {
		this.basename = name.replace(/\.md$/, '');
	}
}

export class App {}

export function normalizePath(p: string): string { return p; }

export class MarkdownView {}
export class TFolder {}
export class PluginSettingTab {}
export class ItemView {}
export class Modal {}
export class Setting {}
export class WorkspaceLeaf {}
export class MarkdownRenderer {}

export function setIcon() {}
