'use client';

// Which surface is rendering the shared Researcher components. One
// component library serves all three; this is the single divergence
// point (block sizing policy + a CSS scope class), never forked markup.
import { createContext, useContext } from 'react';

export type ResearcherSurface = 'drawer' | 'workspace' | 'share';

export const SurfaceContext = createContext<ResearcherSurface>('drawer');
export const useSurface = () => useContext(SurfaceContext);
