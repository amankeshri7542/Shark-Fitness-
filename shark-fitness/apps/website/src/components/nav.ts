export const NAV = [
  { href: '/plans', label: 'Plans' },
  { href: '/classes', label: 'Classes' },
  { href: '/coaches', label: 'Coaches' },
  { href: '/locations', label: 'Locations' },
  { href: '/about', label: 'About' },
  { href: '/faq', label: 'FAQ' },
] as const;

/** A nav item is current on its own page and on pages below it (/locations/hsr). */
export function isCurrent(path: string, href: string): boolean {
  return path === href || path.startsWith(`${href}/`);
}
