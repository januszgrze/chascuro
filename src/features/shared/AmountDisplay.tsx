import type { ReactNode } from 'react';

import type { AmountDisplayMode } from '../../domain';
import { AmountDisplayContext } from './amount-display-context';

export function AmountDisplayProvider({
  mode,
  children,
}: {
  mode: AmountDisplayMode;
  children: ReactNode;
}) {
  return (
    <AmountDisplayContext.Provider value={mode}>
      {children}
    </AmountDisplayContext.Provider>
  );
}
