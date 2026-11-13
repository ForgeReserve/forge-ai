// Default mode: the rings home and the answer screen (docs/design/SCREENS.md, Default mode).
// A mode module is handed t, ui, nav and format, the screens' view and change notice (state.view and
// state.subscribe, never the raw state or the balance key) and the answer actions (ask, stop, again,
// copyAnswer, startFresh). Never the engine, the wallet, storage or an action that moves money.
import { answer } from '../../../screens/answer.js';
import { home } from '../../../screens/home.js';

export function create(inputs) {
  return {
    id: 'default',
    home: (opts) => home(inputs, opts),
    answer: () => answer(inputs),
  };
}
