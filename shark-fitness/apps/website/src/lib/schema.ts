import type { PublicBranch, PublicPlan } from '@shark/contracts';
import { branchExtra, brand, WEEKDAYS, type Faq } from '../content/site';
import { SITE_URL, canonical } from './config';

/** schema.org JSON-LD for the website (Google's structured-data guidelines). */

type Ld = Record<string, unknown>;

const DAY_OF_WEEK: Record<string, string> = {
  mon: 'https://schema.org/Monday',
  tue: 'https://schema.org/Tuesday',
  wed: 'https://schema.org/Wednesday',
  thu: 'https://schema.org/Thursday',
  fri: 'https://schema.org/Friday',
  sat: 'https://schema.org/Saturday',
  sun: 'https://schema.org/Sunday',
};

export function organization(): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: brand.name,
    legalName: brand.legalName,
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/favicon.svg`,
    email: brand.email,
    telephone: brand.phone.replace(/\s/g, ''),
  };
}

export function exerciseGym(branch: PublicBranch): Ld {
  const extra = branchExtra(branch);
  // Days with identical hours are grouped into one specification.
  const groups = new Map<string, string[]>();
  for (const day of WEEKDAYS) {
    const hours = branch.hours[day];
    if (hours.closed || !hours.opens || !hours.closes) continue;
    const key = `${hours.opens}-${hours.closes}`;
    groups.set(key, [...(groups.get(key) ?? []), DAY_OF_WEEK[day]!]);
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'ExerciseGym',
    '@id': `${canonical(`/locations/${branch.slug}`)}#gym`,
    name: `${brand.name} ${extra.area}`,
    alternateName: branch.name,
    url: canonical(`/locations/${branch.slug}`),
    image: `${SITE_URL}/og.png`,
    telephone: branch.phone?.replace(/\s/g, '') ?? undefined,
    email: branch.email ?? undefined,
    priceRange: '₹₹',
    currenciesAccepted: 'INR',
    paymentAccepted: 'Cash, UPI, Credit card, Debit card',
    parentOrganization: { '@id': `${SITE_URL}/#organization` },
    address: {
      '@type': 'PostalAddress',
      streetAddress: branch.addressLine,
      addressLocality: branch.city,
      addressRegion: extra.region,
      postalCode: extra.postalCode || undefined,
      addressCountry: 'IN',
    },
    geo: { '@type': 'GeoCoordinates', latitude: extra.geo.lat, longitude: extra.geo.lng },
    openingHoursSpecification: [...groups.entries()].map(([key, days]) => {
      const [opens, closes] = key.split('-');
      return { '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens, closes };
    }),
    amenityFeature: branch.amenities.map((name) => ({ '@type': 'LocationFeatureSpecification', name, value: true })),
  };
}

export function planOffers(plans: PublicPlan[]): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'OfferCatalog',
    name: `${brand.name} plans and prices`,
    url: canonical('/plans'),
    itemListElement: plans.map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      description: plan.description,
      url: `${canonical('/plans')}#${plan.id}`,
      price: (plan.totalMinor / 100).toFixed(2),
      priceCurrency: plan.currency,
      availability: 'https://schema.org/InStock',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: (plan.totalMinor / 100).toFixed(2),
        priceCurrency: plan.currency,
        valueAddedTaxIncluded: true,
        ...(plan.cadence === 'monthly' ? { billingDuration: 'P1M', unitText: 'month' } : {}),
        ...(plan.cadence === 'annual' ? { billingDuration: 'P1Y', unitText: 'year' } : {}),
      },
      seller: { '@id': `${SITE_URL}/#organization` },
    })),
  };
}

export function faqPage(faqs: Faq[]): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  };
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbs(items: Crumb[]): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: canonical(item.path),
    })),
  };
}
