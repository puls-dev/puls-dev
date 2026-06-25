export interface FieldDiff {
  field: string;
  declared: any;
  live: any;
}

export type ResourceStatus = "missing" | "in-sync" | "drift" | "adopted";

export interface ResourceDiff {
  prop: string;
  resource: string;
  status: ResourceStatus;
  changes: FieldDiff[];
  currentCost?: number;
  newCost?: number;
}

export interface StackDiff {
  stackName: string;
  resources: ResourceDiff[];
  hasDrift: boolean;
  totalCurrentCost?: number;
  totalNewCost?: number;
}
