export function stepShortcut(event) {
	if (event.target?.closest?.("input, textarea, select, [contenteditable], [contenteditable=true]")) return null;
	if ((event.metaKey || event.ctrlKey) && !event.altKey) {
		if (event.key.toLowerCase() === "c") return "copy";
		if (event.key.toLowerCase() === "v") return "paste";
		return null;
	}
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (event.code === "Space") return "play";
	if (event.key === "Delete" || event.key === "Backspace") return "delete";
	return null;
}
