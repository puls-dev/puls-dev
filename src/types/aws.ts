export const REGION = {
  US_EAST_1: "us-east-1",
  US_WEST_2: "us-west-2",
  EU_CENTRAL_1: "eu-central-1",
  EU_WEST_1: "eu-west-1",
} as const;

export const DISTRO = {
  TURKEY_CDN: "E1WU2O39ZREE9O",
  TURKEY_GAME: "E1KFYIGPYK8UVJ",
} as const;

export const BUCKET = {
  NLC_GAMES_UREG: "nl-games-ureg",
};

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
  FIRSTNAME: "user-register",
  LASTNAME: "random-name",
  EMAIL: "operations@nolimit.city",
  MOBILE: "+46701231313",
  CONTACT_TYPE: "COMPANY",
  ORGANIZATION: "Nolimit City Stockholm",
  ADDRESSLINE: "Kungsgatan 49",
  CITY: "Stockholm",
  ZIPCODE: "611 32",
  COUNTRY: "SE",
};
