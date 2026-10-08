// Placeholder renderer from the core scaffold. The UI engineer owns src/renderer/** and replaces this
// wholesale; when merging claude/core with gpt/ui, take gpt/ui's version of this directory.
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<p>Harbor core scaffold: window.harbor is {typeof window.harbor}</p>);
