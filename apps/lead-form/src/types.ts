export interface FormValues {
  // Step 1: Desired Loan Amount
  requested_amount: number | "";

  // Step 3: Loan Purpose
  "loan purpose": string;

  // Step 4: Full Legal Name & Date of Birth
  "first name": string;
  last_name: string;
  "birth date": string;

  // Step 5: Email
  email: string;

  // Step 7: Phone Number
  "home phone": string;

  // Step 8: Current Residential Address
  zip: string;
  address: string;
  apt?: string; // Optional apartment/unit field
  city: string;
  state: string;

  // Step 9: Time At Address
  address_length_months: string;

  // Step 10: Rent Or Own
  own_home: string; // "1" = own, "0" = rent/live with parents

  // Step 11: Income Type
  income_type: string;

  // Step 12: Job Info
  employer: string;
  job_title: string;
  "work phone": string;

  // Step 13: Time With Employer
  employed_months: string;

  // Step 14: Paycheck Info
  pay_date1: string;
  pay_frequency: string;
  direct_deposit: string; // "1" = electronic deposit, "0" = check
  monthly_income: string;
}

export interface StepConfig {
  id: number;
  title: string;
  guidance: string;
  fields: (keyof FormValues)[];
}
