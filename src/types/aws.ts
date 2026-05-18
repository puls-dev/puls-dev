// Define your secret IDs here — reference them everywhere instead of raw strings.
// Example:
// export const SECRETS = {
//   API_KEY:     "myapp/api-key",
//   DB_PASSWORD: "myapp/db-password",
// } as const;

export const DB = {
  POSTGRES_16: { engine: "postgres", version: "16" },
  POSTGRES_15: { engine: "postgres", version: "15" },
  MYSQL_8: { engine: "mysql", version: "8.0" },
  MARIADB_11: { engine: "mariadb", version: "11.4" },
} as const;

export const DB_SIZE = {
  MICRO: "db.t3.micro", // free tier eligible
  SMALL: "db.t3.small",
  MEDIUM: "db.t3.medium",
  LARGE: "db.r6g.large",
} as const;

export const RUNTIME = {
  NODEJS_20: "nodejs20.x",
  NODEJS_18: "nodejs18.x",
  PYTHON_3_12: "python3.12",
  PYTHON_3_11: "python3.11",
  JAVA_21: "java21",
  DOTNET_8: "dotnet8",
} as const;

export const SECRETS = {
  API_KEY: "myapp/api-key",
  SUPERSECRET: "test-secret-super-secret",
} as const;

export const REGION = {
  US_EAST_1: "us-east-1",
  US_WEST_2: "us-west-2",
  EU_CENTRAL_1: "eu-central-1",
  EU_WEST_1: "eu-west-1",
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
  FIRSTNAME: "first-name",
  LASTNAME: "last-name",
  EMAIL: "email@domain.com",
  MOBILE: "+46.xxxxxx",
  CONTACT_TYPE: "COMPANY",
  ORGANIZATION: "company.com",
  ADDRESSLINE: "address-line",
  CITY: "city",
  ZIPCODE: "zip-code",
  COUNTRY: "country",
};
