import { createContext, useContext } from 'react';

import {
  DEFAULT_AMOUNT_DISPLAY_MODE,
  type AmountDisplayMode,
} from '../../domain';

export const AmountDisplayContext = createContext<AmountDisplayMode>(
  DEFAULT_AMOUNT_DISPLAY_MODE,
);

export function useAmountDisplayMode(): AmountDisplayMode {
  return useContext(AmountDisplayContext);
}
