// Default mode: the rings home and the answer screen (docs/design/SCREENS.md, Default mode).
// A mode module is handed t, ui, state, nav, actions and format; never the engine, the wallet or storage.
import { answer } from '../../../screens/answer.js';
import { home } from '../../../screens/home.js';

export function create(inputs) {
  return {
    id: 'default',
    home: (opts) => home(inputs, opts),
    answer: () => answer(inputs),
  };
}
