export const PLATFORM_NAME = 'AkuvoxSmartPlus';
export const PLUGIN_NAME = 'homebridge-akuvox-smartplus';

/** Akuvox cloud region subdomains, as used in `gate.<region>.akuvox.com`. */
export const REGIONS = ['ecloud', 'ucloud', 'scloud', 'jcloud', 'ccloud', 'rucloud'] as const;
export type Region = (typeof REGIONS)[number];
