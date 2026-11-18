import { describe, expect, it } from "vitest"
import type { ApiChange } from "./apiChange.ts"
import { PROTOBUF } from "./protobuf.ts"

/** Compares one file's two versions. */
function compare(before: string, after: string): ApiChange[] {
  return PROTOBUF.compare([{ path: "shop.proto", text: before }], [{ path: "shop.proto", text: after }])
}

function summary(changes: readonly ApiChange[]): string[] {
  return changes.map((change) => `${change.kind} ${change.subject}${change.change === undefined ? "" : ` (${change.change})`}@${change.line ?? "-"}`)
}

const BEFORE = `syntax = "proto3";
package shop.v1;

import "google/protobuf/timestamp.proto";
option go_package = "example.com/shop/v1";

// Orders, as the API returns them.
message Order {
  string id = 1;
  repeated Item items = 2;
  int64 total_cents = 3 [deprecated = true];
  map<string, string> labels = 4;
  oneof payer {
    string user_id = 5;
    string guest_email = 6;
  }
  message Item {
    string sku = 1;
    int32 qty = 2;
  }
  reserved 9, 20 to max;
}

enum Status {
  STATUS_UNSPECIFIED = 0;
  STATUS_OPEN = 1;
  STATUS_CLOSED = 2;
}

service Orders {
  rpc GetOrder (GetOrderRequest) returns (Order);
  rpc Watch (stream WatchRequest) returns (stream Order) {
    option (google.api.http) = { get: "/v1/orders:watch" };
  }
  rpc Cancel (CancelRequest) returns (Order);
}
`

describe("protobuf", () => {
  it("flags changed numbers and types, removed fields and values, and removed or retyped RPCs", () => {
    const after = BEFORE.replace("  int64 total_cents = 3 [deprecated = true];\n", "  int32 total_cents = 3;\n")
      .replace("    int32 qty = 2;\n", "    int32 qty = 7;\n")
      .replace("    string guest_email = 6;\n", "")
      .replace("  STATUS_CLOSED = 2;\n", "")
      .replace("  rpc Cancel (CancelRequest) returns (Order);\n", "")
      .replace("rpc GetOrder (GetOrderRequest) returns (Order);", "rpc GetOrder (GetOrderRequest) returns (OrderView);")
    expect(summary(compare(BEFORE, after))).toEqual([
      "type-changed shop.v1.Orders.GetOrder (GetOrderRequest → Order to GetOrderRequest → OrderView)@29",
      "operation-removed shop.v1.Orders.Cancel@-",
      "type-changed shop.v1.Order.total_cents (int64 to int32)@11",
      "field-removed shop.v1.Order.guest_email@8",
      "number-changed shop.v1.Order.Item.qty (2 to 7)@18",
      "enum-value-removed shop.v1.Status.STATUS_CLOSED@23",
    ])
  })

  it("accepts a removal whose number is reserved, and flags a rename in place", () => {
    const reserved = BEFORE.replace("  map<string, string> labels = 4;\n", "").replace("reserved 9, 20 to max;", "reserved 4, 9, 20 to max;")
    expect(compare(BEFORE, reserved)).toEqual([])
    const renamed = BEFORE.replace("  string id = 1;", "  string order_id = 1;")
    expect(summary(compare(BEFORE, renamed))).toEqual(["field-removed shop.v1.Order.id@8"])
  })

  it("leaves new fields, messages and RPCs alone", () => {
    const after = BEFORE.replace("  map<string, string> labels = 4;\n", "  map<string, string> labels = 4;\n  string currency = 7;\n").replace("service Orders {", "message Refund { string id = 1; }\n\nservice Orders {\n  rpc Refund (Refund) returns (Refund);")
    expect(compare(BEFORE, after)).toEqual([])
  })

  it("follows a message that moved to another file in its package, and places its changes there", () => {
    const before = [{ path: "a.proto", text: "package p;\nmessage M { string a = 1; string b = 2; }\n" }]
    const after = [
      { path: "a.proto", text: "package p;\n" },
      { path: "b.proto", text: "package p;\n\nmessage M {\n  string a = 1;\n}\n" },
    ]
    expect(PROTOBUF.compare(before, after).map((change) => `${change.kind} ${change.subject} ${change.path}:${change.line ?? "-"}`)).toEqual(["field-removed p.M.b b.proto:3"])
  })

  it("throws on a definition that ends early", () => {
    expect(() => compare(BEFORE, "message Broken {")).toThrow()
  })
})
