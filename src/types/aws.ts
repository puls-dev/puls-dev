export const REGION = {
  US_EAST_1: "us-east-1",
  US_WEST_2: "us-west-2",
  EU_CENTRAL_1: "eu-central-1",
  EU_WEST_1: "eu-west-1",
} as const;

// ALWAYS ensure that these distros exists in CloudFront
export const DISTRO = {
  TURKEY_CDN: "E1WU2O39ZREE9O",
  TURKEY_GAME: "E1KFYIGPYK8UVJ",
  CHECKSUM: "E21JV19WAUU2D0",
} as const;

export const BUCKET = {
  NLC_GAMES_UREG: "nl-games-ureg",
  CHECKSUM: "nl-games-us-mi",
} as const;

export interface RegistrantContact {
  FIRSTNAME: string;
  LASTNAME: string;
  EMAIL: string;
  MOBILE: string;
  CONTACT_TYPE: string;
  ORGANIZATION: string;
  ADDRESSLINE: string;
  CITY: string;
  ZIPCODE: string;
  COUNTRY: string;
}

export const DOMAIN_REGISTER: RegistrantContact = {
  FIRSTNAME: "bia",
  LASTNAME: "andersson",
  EMAIL: "bia@nolimit.city",
  MOBILE: "+46.708339809",
  CONTACT_TYPE: "COMPANY",
  ORGANIZATION: "Nolimit City Stockholm",
  ADDRESSLINE: "Kungsgatan 49",
  CITY: "Stockholm",
  ZIPCODE: "611 32",
  COUNTRY: "SE",
};
