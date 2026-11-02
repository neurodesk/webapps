//! The MATLAB anonymous-function subset that SamSrf model files use for
//! `Prf_Function` and `SeedPar_Function`, e.g.
//! `@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)` and
//! `@(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]`.
//!
//! Grammar: numbers, `pi`, parameter names, indexing `P(i)` and ranges `P(a:b)`,
//! vertical concatenation `[a; b]`, binary `+ - * / ^ .* ./ .^`, unary minus,
//! and calls to the functions in `prf::call` (profile functions, `sqrt`, `log`,
//! `exp`, `abs`, `atan2`, `cosd`, `sind`, `cos`, `sin`, `mod`). An unknown function
//! fails at evaluation with its name in the error.

use crate::error::Result;

/// A column-major matrix; a scalar is `1 x 1`. MATLAB semantics: scalar operands
/// broadcast, `*` between non-scalars is a matrix product, `.*` is elementwise.
#[derive(Debug, Clone, PartialEq)]
pub struct Value {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<f64>,
}

impl Value {
    pub fn scalar(value: f64) -> Self {
        Value { rows: 1, cols: 1, data: vec![value] }
    }

    pub fn column(data: Vec<f64>) -> Self {
        Value { rows: data.len(), cols: 1, data }
    }

    pub fn is_scalar(&self) -> bool {
        self.rows == 1 && self.cols == 1
    }

    pub fn as_scalar(&self) -> Result<f64> {
        if self.is_scalar() {
            Ok(self.data[0])
        } else {
            Err(crate::Error::Expression(format!("expected a scalar, got a {} x {} matrix", self.rows, self.cols)))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    ElementMultiply,
    ElementDivide,
    ElementPower,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Number(f64),
    Pi,
    Variable(String),
    /// `name(index)` or `name(a:b)` on a bound variable (1-based, inclusive).
    Index { variable: String, from: Box<Expr>, to: Option<Box<Expr>> },
    Call { function: String, args: Vec<Expr> },
    Negate(Box<Expr>),
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
    /// `[a; b; ...]`: rows stacked vertically.
    VerticalConcat(Vec<Expr>),
}

/// `@(P,ApWidth) body`, kept with its source so provenance can quote it.
#[derive(Debug, Clone, PartialEq)]
pub struct AnonymousFunction {
    pub source: String,
    pub params: Vec<String>,
    pub body: Expr,
}

impl AnonymousFunction {
    /// Parses an anonymous-function string. Whitespace is free; the `@(...)` header is required.
    pub fn parse(source: &str) -> Result<Self> {
        let _ = source;
        Err(crate::Error::NotImplemented("AnonymousFunction::parse"))
    }

    /// Evaluates the body with `args` bound to `params` in order. Calls resolve through
    /// `prf::call`, which includes the pRF profile functions.
    pub fn evaluate(&self, args: &[Value]) -> Result<Value> {
        let _ = args;
        Err(crate::Error::NotImplemented("AnonymousFunction::evaluate"))
    }
}
