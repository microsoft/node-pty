export interface HelperPublisherPolicy {
  subject: string;
  issuer?: string;
}

// Release tooling can set the approved full subject in this trusted source file.
// An empty default deliberately keeps affected Windows builds on the Node transport.
export const helperPublisherPolicy: HelperPublisherPolicy = Object.freeze({ subject: "" });
