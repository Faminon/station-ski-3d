import { NextResponse, type NextRequest } from 'next/server';
import { embedFrameAncestors } from '@/lib/skiDomains';

/**
 * Carte intégrée (/embed/<domaine>) : seuls AltiStay et les sites de la station,
 * listés dans src/lib/skiDomains.ts, peuvent l'afficher dans une iframe. Les autres
 * pages refusent toute intégration (voir `headers` dans next.config.ts).
 */
export function proxy(request: NextRequest) {
  const slug = request.nextUrl.pathname.split('/')[2] ?? '';
  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', embedFrameAncestors(slug));
  return response;
}

export const config = {
  matcher: '/embed/:path*',
};
