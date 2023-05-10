import GenericGraph from "../utils/Graph";

// The following three regions define the core types for our automatic
// differentiation engine.
//
// - The "implicit" representation is used essentially as a DSL to construct
//   computation graphs, via the convenience functions provided in
//   engine/AutodiffFunctions. It does not include any information about
//   derivatives, because those can can be constructed symbolically from the
//   implicit representation. Naïvely serializing the implicit representation
//   would produce a tree structure with a lot of redundancy, because some nodes
//   that can be reached by following different paths are actually identical.
//
// - The "explicit" representation is an intermediate structure used to
//   represent a computation graph, with derivatives included alongside
//   everything else. The number of nodes and edges are unambiguously stored,
//   and each node has a unique ID so structural sharing is not represented
//   purely by object identity. The main value of this representation is that we
//   can call an off-the-shelf topological sort function on it, which is useful
//   both while constructing the derivatives within it and also while compiling
//   it to the final representation.
//
// - The "compiled" representation is a WebAssembly module which exports a
//   function that computes a function and its gradient.
//
// We only need to compute the gradient of the energy, but we also need to to
// compute other values that may not even be intermediate computations for the
// energy. Thus, the explicit representation (but not the implicit
// representation) distinguishes the "primary" output (for which the gradient is
// computed) from "secondary" outputs (for which no derivatives are computed).

//#region Types for implicit autodiff graph

export type Expr = Bool | Num | Vec;

export type Bool = Comp | Logic | Not;

export type Num = number | Input | Unary | Binary | Ternary | Nary | Index;

export type Vec = PolyRoots;

export interface Input extends InputNode {
  // HACK: Historically, every Num contained a `val` field which would hold
  // the "value of this node at the time the computational graph was created".
  // In particular, every function in `engine/AutodiffFunctions` contained code
  // to compute the initial value of a node based on the initial values of its
  // inputs, completely independent of the semantics defined by the logic for
  // generating JavaScript code from a computation graph (which is what actually
  // gets used in the optimizer loop). This makes maintenance harder because
  // discrepancies between these two semantics can result in subtle bugs (and
  // indeed, there were some minor discrepancies; see the description of PR #907
  // for more details). Thus, the new implementation does not keep track of
  // initial values for intermediate nodes. However, some functions used while
  // constructing the computation graph (such as `convexPartitions` in
  // `contrib/Minkowski`) need to do ahead-of-time computation on these initial
  // values, because their results affect the shape of the computation graph
  // itself, and we currently don't have a way for the shape of the graph to
  // change during optimization. This isn't a perfect solution because the
  // precomputed graph can be wrong if the inputs change in unexpected ways, but
  // until we find a better solution, we need some escape hatch to allow those
  // few functions to access the initial values for their arguments at graph
  // construction time. The approach we ended up with is to store the initial
  // values of just the `Input` nodes in the `val` field defined here, and when
  // a function needs to compute the initial values of its arguments, it can
  // compile them to JavaScript code and evaluate that with the initial values
  // of those `Input`s. This is hacky, but that's understood: it should be used
  // sparingly.
  val: number;
}

export interface Unary extends UnaryNode {
  param: Num;
}

export interface Binary extends BinaryNode {
  left: Num;
  right: Num;
}

export interface Comp extends CompNode {
  left: Num;
  right: Num;
}

export interface Logic extends LogicNode {
  left: Bool;
  right: Bool;
}

export interface Not extends NotNode {
  param: Bool;
}

export interface Ternary extends TernaryNode {
  cond: Bool;
  then: Num;
  els: Num;
}

export interface Nary extends NaryNode {
  params: Num[];
}

export interface PolyRoots extends PolyRootsNode {
  // coefficients of a monic polynomial with degree `coeffs.length`
  coeffs: Num[];
}

export interface Index extends IndexNode {
  vec: Vec;
}

//#endregion

//#region Types for explicit autodiff graph

export type Node =
  | number
  | InputNode
  | UnaryNode
  | BinaryNode
  | CompNode
  | LogicNode
  | TernaryNode
  | NaryNode
  | PolyRootsNode
  | IndexNode
  | NotNode;

export interface InputNode {
  tag: "Input";
  key: number;
}

export interface UnaryNode {
  tag: "Unary";
  unop:
    | "neg"
    | "squared"
    | "sqrt"
    | "inverse"
    | "abs"
    | "acosh"
    | "acos"
    | "asin"
    | "asinh"
    | "atan"
    | "atanh"
    | "cbrt"
    | "ceil"
    | "cos"
    | "cosh"
    | "exp"
    | "expm1"
    | "floor"
    | "log"
    | "log2"
    | "log10"
    | "log1p"
    | "round"
    | "sign"
    | "sin"
    | "sinh"
    | "tan"
    | "tanh"
    | "trunc";
}

export interface BinaryNode {
  tag: "Binary";
  binop: "+" | "*" | "-" | "/" | "max" | "min" | "atan2" | "pow";
}

export interface CompNode {
  tag: "Comp";
  binop: ">" | "<" | "===" | ">=" | "<=";
}

export interface NotNode {
  tag: "Not";
}

export interface LogicNode {
  tag: "Logic";
  binop: "&&" | "||" | "!==";
}

export interface TernaryNode {
  tag: "Ternary";
}

export interface NaryNode {
  tag: "Nary";
  op: "addN" | "maxN" | "minN";
}

export interface PolyRootsNode {
  tag: "PolyRoots";
  degree: number;
}

export interface IndexNode {
  tag: "Index";
  index: number;
}

export type Edge = number;

export type Id = number;

export interface Graph extends Outputs<Id> {
  graph: GenericGraph<Id, Node, Edge>; // edges point from children to parents
  nodes: Map<Expr, Id>;
}

//#endregion

//#region Types for compiled autodiff graph

/**
 * A structure used to collect the various outputs of a `Gradient` function.
 * This is generic in the concrete number type, because it can also be useful in
 * situations where the elements are, for instance, computation graph nodes.
 */
export interface Outputs<T> {
  /** Derivatives of primary output with respect to inputs. */
  gradient: T[];
  /** Primary output. */
  primary: T;
  /** Secondary outputs. */
  secondary: T[];
}

export type Compiled = (inputs: number[], mask?: boolean[]) => Outputs<number>;

export interface OptOutputs {
  phi: number; // see `Fn` from `@penrose/optimizer`
  objectives: number[];
  constraints: number[];
}

export interface Masks {
  inputMask: boolean[];
  objMask: boolean[];
  constrMask: boolean[];
}

// you can think of the `Fn` type from `@penrose/optimizer` as this type
// partially applied with `masks` and projecting out the `phi` field
export type Gradient = (
  masks: Masks,
  inputs: Float64Array,
  weight: number,
  grad: Float64Array
) => OptOutputs;

//#endregion

//#region Types for generalizing our system autodiff

export type Pt2 = [Num, Num];

export const isPt2 = (vec: Num[]): vec is Pt2 => vec.length === 2;

//#endregion
