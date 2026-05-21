import type { ProviderName } from '../agent/types';

export function buildEditFormatHint(provider: ProviderName, model: string): string {
	const providerRule = (() => {
		switch (provider) {
			case 'anthropic':
				return 'Bevorzuge XML-artige Edit-Bloecke mit <edit>, <search> und <replace>.';
			case 'gemini':
				return 'Bevorzuge fenced Edit-Bloecke mit klar markiertem SEARCH und REPLACE.';
			case 'ollama':
				return 'Bei kleineren lokalen Modellen: bevorzuge einfache, vollstaendige und robuste Edits statt filigraner Mikropatches.';
			case 'openai':
			default:
				return 'Bevorzuge klare SEARCH/REPLACE-Edits mit ausreichend Kontext statt unpraeziser Freitext-Bearbeitungen.';
		}
	})();

	return [
		'<edit_format_rules>',
		'Wenn du write_file oder patch_file planst, halte dich an diese Regeln:',
		'- Lies die Zieldatei zuerst, wenn ihr exakter Inhalt noch nicht im Kontext oder in tool_results steht.',
		'- Fuer patch_file muss oldText exakt oder nahezu exakt aus der Datei stammen.',
		'- Jeder Patch soll mindestens 2 Zeilen stabilen Kontext oberhalb und unterhalb der eigentlichen Aenderung enthalten, sofern moeglich.',
		'- Wenn die Aenderungsstelle mehrfach vorkommen koennte, erweitere oldText, statt einen kurzen mehrdeutigen Ausschnitt zu senden.',
		'- Wenn ein vorheriger Patch mit "oldText not found" oder "ambiguous match" fehlschlug, verwende den frisch gelesenen Dateistand und erzeuge einen neuen, groesseren Patch.',
		'- Wenn ein exakter Patch unzuverlaessig ist und die Aufgabe eine groessere Umstrukturierung verlangt, darfst du write_file mit overwrite=true bevorzugen.',
		`- Providerspezifische Regel: ${providerRule}`,
		`- Aktuelles Modell: ${model}`,
		'</edit_format_rules>',
	].join('\n');
}
