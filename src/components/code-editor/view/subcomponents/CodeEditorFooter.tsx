type CodeEditorFooterProps = {
  content: string;
  linesLabel: string;
  charactersLabel: string;
  shortcutsLabel: string;
};

export default function CodeEditorFooter({
  content,
  linesLabel,
  charactersLabel,
  shortcutsLabel,
}: CodeEditorFooterProps) {
  return (
    // Hidden below `sm`: this whole bar is a keyboard hint ("Ctrl+S to save,
    // Esc to close") plus a line/character count, none of which applies on a
    // phone — and on a short landscape viewport it was costing a meaningful
    // slice of the code area.
    <div className="hidden flex-shrink-0 items-center justify-between border-t border-border bg-muted px-3 py-1.5 sm:flex">
      <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400">
        <span>
          {linesLabel} {content.split('\n').length}
        </span>
        <span>
          {charactersLabel} {content.length}
        </span>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400">{shortcutsLabel}</div>
    </div>
  );
}
