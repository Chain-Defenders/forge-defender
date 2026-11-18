// Turns an Anchor IDL into a display tree. Handles the 0.30+ format (address at the top, discriminators, types
// referenced by `{ defined: { name } }`) and the older one (name at the top, isMut/isSigner, `{ defined: "Name" }`).

export interface IdlNode {
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id for the view. */
  icon?: string;
  children?: IdlNode[];
}

// IDL files come from many Anchor versions; fields are checked where they are used.
type Json = any;

export interface IdlSummary {
  name: string;
  address?: string;
  legacy: boolean;
  nodes: IdlNode[];
}

export function typeName(t: Json): string {
  if (typeof t === "string") return t === "publicKey" ? "pubkey" : t;
  if (!t || typeof t !== "object") return "?";
  if ("vec" in t) return `Vec<${typeName(t.vec)}>`;
  if ("option" in t) return `Option<${typeName(t.option)}>`;
  if ("coption" in t) return `COption<${typeName(t.coption)}>`;
  if ("array" in t) return `[${typeName(t.array[0])}; ${typeof t.array[1] === "object" ? t.array[1]?.generic ?? "?" : t.array[1]}]`;
  if ("defined" in t) {
    const d = t.defined;
    if (typeof d === "string") return d;
    const generics = (d.generics ?? []).map((g: Json) => (g.kind === "type" ? typeName(g.type) : String(g.value)));
    return generics.length ? `${d.name}<${generics.join(", ")}>` : d.name;
  }
  if ("generic" in t) return t.generic;
  return JSON.stringify(t);
}

function fieldNodes(fields: Json[] | undefined): IdlNode[] {
  return (fields ?? []).map((f, i) =>
    typeof f === "object" && f && "name" in f
      ? { label: f.name, description: typeName(f.type), icon: "symbol-field" }
      : { label: String(i), description: typeName(f), icon: "symbol-field" },
  );
}

function typeDefNode(def: Json): IdlNode {
  const t = def.type ?? {};
  if (t.kind === "enum") {
    return {
      label: def.name,
      description: "enum",
      icon: "symbol-enum",
      children: (t.variants ?? []).map((v: Json) => ({
        label: v.name,
        icon: "symbol-enum-member",
        children: v.fields?.length ? fieldNodes(v.fields) : undefined,
      })),
    };
  }
  if (t.kind === "type") return { label: def.name, description: `= ${typeName(t.alias)}`, icon: "symbol-type-parameter" };
  return { label: def.name, description: "struct", icon: "symbol-struct", children: fieldNodes(t.fields) };
}

function seedText(seed: Json): string {
  if (seed.kind === "const") {
    const bytes: number[] = seed.value ?? [];
    const printable = bytes.length > 0 && bytes.every((b) => b >= 0x20 && b < 0x7f);
    return printable ? `"${String.fromCharCode(...bytes)}"` : `[${bytes.join(", ")}]`;
  }
  return `${seed.kind}: ${seed.path ?? "?"}`;
}

function accountNode(a: Json): IdlNode {
  if (Array.isArray(a.accounts)) return { label: a.name, description: "group", icon: "folder", children: a.accounts.map(accountNode) };
  const flags: string[] = [];
  if (a.writable || a.isMut) flags.push("mut");
  if (a.signer || a.isSigner) flags.push("signer");
  if (a.optional || a.isOptional) flags.push("optional");
  if (a.pda) flags.push("PDA");
  const tips: string[] = [];
  if (a.address) tips.push(`Address: ${a.address}`);
  if (a.pda?.seeds) tips.push(`Seeds: ${a.pda.seeds.map(seedText).join(", ")}`);
  if (a.pda?.program) tips.push(`Program: ${seedText(a.pda.program)}`);
  if (a.relations?.length) tips.push(`has_one of: ${a.relations.join(", ")}`);
  const docs = a.docs ?? (a.desc ? [a.desc] : []);
  if (docs.length) tips.push(docs.join(" "));
  return {
    label: a.name,
    description: [flags.join(", "), a.address && !a.pda ? short(a.address) : ""].filter(Boolean).join("  "),
    tooltip: tips.length ? tips.join("\n") : undefined,
    icon: a.signer || a.isSigner ? "key" : "symbol-variable",
  };
}

const short = (address: string) => (address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

function section(label: string, children: IdlNode[], icon: string): IdlNode[] {
  return children.length ? [{ label, description: String(children.length), icon, children }] : [];
}

export function parseIdl(idl: Json): IdlSummary {
  const legacy = !idl.address && !idl.metadata?.spec;
  const name = idl.metadata?.name ?? idl.name ?? "program";
  const address = idl.address ?? idl.metadata?.address;
  const types: Json[] = idl.types ?? [];
  const typeByName = new Map(types.map((t) => [t.name, t]));

  const instructions = (idl.instructions ?? []).map(
    (ix: Json): IdlNode => ({
      label: ix.name,
      description: (ix.args ?? []).map((a: Json) => `${a.name}: ${typeName(a.type)}`).join(", "),
      tooltip: ix.docs?.join(" "),
      icon: "symbol-method",
      children: [
        ...section("Accounts", (ix.accounts ?? []).map(accountNode), "symbol-namespace"),
        ...section(
          "Args",
          (ix.args ?? []).map((a: Json) => ({ label: a.name, description: typeName(a.type), icon: "symbol-parameter" })),
          "symbol-parameter",
        ),
      ],
    }),
  );

  // In the new format an account's layout is in `types`; in the old one it is inline.
  const accounts = (idl.accounts ?? []).map((a: Json): IdlNode => {
    const def = a.type ? a : typeByName.get(a.name);
    return { ...(def ? typeDefNode(def) : { label: a.name }), label: a.name, icon: "database" };
  });
  const events = (idl.events ?? []).map((e: Json): IdlNode => {
    const def = e.fields ? { name: e.name, type: { kind: "struct", fields: e.fields } } : typeByName.get(e.name);
    return { ...(def ? typeDefNode(def) : { label: e.name }), label: e.name, description: undefined, icon: "symbol-event" };
  });
  const errors = (idl.errors ?? []).map(
    (e: Json): IdlNode => ({ label: `${e.code} ${e.name}`, description: e.msg, tooltip: e.msg, icon: "error" }),
  );
  const constants = (idl.constants ?? []).map(
    (c: Json): IdlNode => ({ label: c.name, description: `${typeName(c.type)} = ${c.value}`, icon: "symbol-constant" }),
  );

  return {
    name,
    address,
    legacy,
    nodes: [
      ...section("Instructions", instructions, "symbol-method"),
      ...section("Accounts", accounts, "database"),
      ...section("Types", types.map(typeDefNode), "symbol-struct"),
      ...section("Events", events, "symbol-event"),
      ...section("Errors", errors, "error"),
      ...section("Constants", constants, "symbol-constant"),
    ],
  };
}
