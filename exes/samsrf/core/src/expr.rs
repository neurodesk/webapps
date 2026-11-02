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
//!
//! Precedence follows MATLAB: `^` and `.^` bind tightest and associate left
//! (`2^3^2 = 64`), unary minus is next (`-2^2 = -4`, and `2^-1` is allowed), then
//! `* / .* ./`, then `+ -`. Horizontal concatenation (`[a, b]` or `[a b]`) is not
//! supported: SamSrf models only stack vertically, and inside brackets whitespace
//! is insignificant, so `[a -b]` parses as `a - b`.

use crate::error::{Error, Result};

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

    /// Applies `f` to every element, keeping the shape.
    pub fn map(&self, f: impl Fn(f64) -> f64) -> Value {
        Value { rows: self.rows, cols: self.cols, data: self.data.iter().map(|value| f(*value)).collect() }
    }

    /// Elementwise `f(left, right)` with MATLAB broadcasting: a scalar operand expands to
    /// the other's shape; two matrices must have the same shape.
    pub fn zip_with(&self, right: &Value, f: impl Fn(f64, f64) -> f64) -> Result<Value> {
        if self.is_scalar() {
            let left = self.data[0];
            return Ok(right.map(|value| f(left, value)));
        }
        if right.is_scalar() {
            let right = right.data[0];
            return Ok(self.map(|value| f(value, right)));
        }
        if self.rows != right.rows || self.cols != right.cols {
            return Err(Error::Expression(format!(
                "matrix dimensions must agree: {} x {} against {} x {}",
                self.rows, self.cols, right.rows, right.cols
            )));
        }
        let data = self.data.iter().zip(&right.data).map(|(left, right)| f(*left, *right)).collect();
        Ok(Value { rows: self.rows, cols: self.cols, data })
    }

    /// `self * right` as a matrix product (`inner` dimensions must agree).
    fn matrix_product(&self, right: &Value) -> Result<Value> {
        if self.cols != right.rows {
            return Err(Error::Expression(format!(
                "inner matrix dimensions must agree: {} x {} times {} x {}",
                self.rows, self.cols, right.rows, right.cols
            )));
        }
        let mut data = vec![0.0; self.rows * right.cols];
        for column in 0..right.cols {
            for row in 0..self.rows {
                let mut sum = 0.0;
                for inner in 0..self.cols {
                    sum += self.data[inner * self.rows + row] * right.data[column * right.rows + inner];
                }
                data[column * self.rows + row] = sum;
            }
        }
        Ok(Value { rows: self.rows, cols: right.cols, data })
    }

    /// 1-based linear index, as `P(i)`.
    fn index(&self, variable: &str, index: f64) -> Result<f64> {
        if index.fract() != 0.0 || index < 1.0 {
            return Err(Error::Expression(format!("index {index} into `{variable}` is not a positive integer")));
        }
        let position = index as usize;
        self.data.get(position - 1).copied().ok_or_else(|| {
            Error::Expression(format!("index {position} out of range for `{variable}` with {} elements", self.data.len()))
        })
    }

    /// `P(a:b)`: inclusive 1-based range. A row vector yields a row, anything else a column.
    fn range(&self, variable: &str, from: f64, to: f64) -> Result<Value> {
        let mut data = Vec::new();
        let mut index = from;
        while index <= to {
            data.push(self.index(variable, index)?);
            index += 1.0;
        }
        if self.rows == 1 && self.cols > 1 {
            Ok(Value { rows: 1, cols: data.len(), data })
        } else {
            Ok(Value::column(data))
        }
    }

    /// `[a; b; ...]`: every block must have the same column count.
    fn vertical_concat(blocks: &[Value]) -> Result<Value> {
        let cols = blocks.iter().map(|block| block.cols).max().unwrap_or(0);
        let mut rows = 0;
        for block in blocks {
            if block.cols != cols && !(block.rows == 0 && block.cols == 0) {
                return Err(Error::Expression(format!(
                    "vertical dimensions mismatch: {} columns against {} columns",
                    block.cols, cols
                )));
            }
            rows += block.rows;
        }
        let mut data = Vec::with_capacity(rows * cols);
        for column in 0..cols {
            for block in blocks {
                if block.cols == 0 {
                    continue;
                }
                let start = column * block.rows;
                data.extend_from_slice(&block.data[start..start + block.rows]);
            }
        }
        Ok(Value { rows, cols, data })
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

impl BinaryOp {
    fn apply(self, left: &Value, right: &Value) -> Result<Value> {
        match self {
            BinaryOp::Add => left.zip_with(right, |a, b| a + b),
            BinaryOp::Subtract => left.zip_with(right, |a, b| a - b),
            BinaryOp::ElementMultiply => left.zip_with(right, |a, b| a * b),
            BinaryOp::ElementDivide => left.zip_with(right, |a, b| a / b),
            BinaryOp::ElementPower => left.zip_with(right, f64::powf),
            BinaryOp::Multiply => {
                if left.is_scalar() || right.is_scalar() {
                    left.zip_with(right, |a, b| a * b)
                } else {
                    left.matrix_product(right)
                }
            }
            BinaryOp::Divide => {
                if right.is_scalar() {
                    left.zip_with(right, |a, b| a / b)
                } else {
                    Err(Error::Expression("matrix division `/` by a non-scalar is not supported; use `./`".into()))
                }
            }
            BinaryOp::Power => {
                if left.is_scalar() && right.is_scalar() {
                    Ok(Value::scalar(left.data[0].powf(right.data[0])))
                } else {
                    Err(Error::Expression("matrix power `^` of a non-scalar is not supported; use `.^`".into()))
                }
            }
        }
    }
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

impl Expr {
    fn evaluate(&self, scope: &[(&str, &Value)]) -> Result<Value> {
        match self {
            Expr::Number(value) => Ok(Value::scalar(*value)),
            Expr::Pi => Ok(Value::scalar(std::f64::consts::PI)),
            Expr::Variable(name) => lookup(scope, name).cloned(),
            Expr::Index { variable, from, to } => {
                let source = lookup(scope, variable)?;
                let from = from.evaluate(scope)?.as_scalar()?;
                match to {
                    None => Ok(Value::scalar(source.index(variable, from)?)),
                    Some(to) => {
                        let to = to.evaluate(scope)?.as_scalar()?;
                        source.range(variable, from, to)
                    }
                }
            }
            Expr::Call { function, args } => {
                let args = args.iter().map(|arg| arg.evaluate(scope)).collect::<Result<Vec<Value>>>()?;
                crate::prf::call(function, &args)
            }
            Expr::Negate(inner) => Ok(inner.evaluate(scope)?.map(|value| -value)),
            Expr::Binary { op, left, right } => {
                let left = left.evaluate(scope)?;
                let right = right.evaluate(scope)?;
                op.apply(&left, &right)
            }
            Expr::VerticalConcat(blocks) => {
                let blocks = blocks.iter().map(|block| block.evaluate(scope)).collect::<Result<Vec<Value>>>()?;
                Value::vertical_concat(&blocks)
            }
        }
    }
}

fn lookup<'a>(scope: &[(&str, &'a Value)], name: &str) -> Result<&'a Value> {
    scope
        .iter()
        .find(|(parameter, _)| *parameter == name)
        .map(|(_, value)| *value)
        .ok_or_else(|| Error::Expression(format!("unknown variable `{name}`")))
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
        let tokens = tokenize(source)?;
        let mut parser = Parser { tokens, position: 0, params: Vec::new() };
        parser.expect(&Token::At)?;
        parser.expect(&Token::LeftParen)?;
        if !parser.eat(&Token::RightParen) {
            loop {
                let name = parser.identifier()?;
                parser.params.push(name);
                if parser.eat(&Token::RightParen) {
                    break;
                }
                parser.expect(&Token::Comma)?;
            }
        }
        let body = parser.expression()?;
        if parser.position != parser.tokens.len() {
            return Err(Error::Expression(format!("unexpected `{}` after the function body", parser.tokens[parser.position])));
        }
        Ok(AnonymousFunction { source: source.to_string(), params: parser.params, body })
    }

    /// Evaluates the body with `args` bound to `params` in order. Calls resolve through
    /// `prf::call`, which includes the pRF profile functions.
    pub fn evaluate(&self, args: &[Value]) -> Result<Value> {
        if args.len() != self.params.len() {
            return Err(Error::Expression(format!(
                "`{}` takes {} argument(s), {} given",
                self.source,
                self.params.len(),
                args.len()
            )));
        }
        let scope: Vec<(&str, &Value)> = self.params.iter().map(String::as_str).zip(args).collect();
        self.body.evaluate(&scope)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Identifier(String),
    At,
    LeftParen,
    RightParen,
    LeftBracket,
    RightBracket,
    Semicolon,
    Comma,
    Colon,
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    DotStar,
    DotSlash,
    DotCaret,
}

impl std::fmt::Display for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Token::Number(value) => write!(f, "{value}"),
            Token::Identifier(name) => write!(f, "{name}"),
            Token::At => write!(f, "@"),
            Token::LeftParen => write!(f, "("),
            Token::RightParen => write!(f, ")"),
            Token::LeftBracket => write!(f, "["),
            Token::RightBracket => write!(f, "]"),
            Token::Semicolon => write!(f, ";"),
            Token::Comma => write!(f, ","),
            Token::Colon => write!(f, ":"),
            Token::Plus => write!(f, "+"),
            Token::Minus => write!(f, "-"),
            Token::Star => write!(f, "*"),
            Token::Slash => write!(f, "/"),
            Token::Caret => write!(f, "^"),
            Token::DotStar => write!(f, ".*"),
            Token::DotSlash => write!(f, "./"),
            Token::DotCaret => write!(f, ".^"),
        }
    }
}

fn tokenize(source: &str) -> Result<Vec<Token>> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let simple = match c {
            '@' => Some(Token::At),
            '(' => Some(Token::LeftParen),
            ')' => Some(Token::RightParen),
            '[' => Some(Token::LeftBracket),
            ']' => Some(Token::RightBracket),
            ';' => Some(Token::Semicolon),
            ',' => Some(Token::Comma),
            ':' => Some(Token::Colon),
            '+' => Some(Token::Plus),
            '-' => Some(Token::Minus),
            '*' => Some(Token::Star),
            '/' => Some(Token::Slash),
            '^' => Some(Token::Caret),
            _ => None,
        };
        if let Some(token) = simple {
            tokens.push(token);
            i += 1;
            continue;
        }
        if c == '.' {
            let token = match next {
                Some('*') => Some(Token::DotStar),
                Some('/') => Some(Token::DotSlash),
                Some('^') => Some(Token::DotCaret),
                _ => None,
            };
            if let Some(token) = token {
                tokens.push(token);
                i += 2;
                continue;
            }
        }
        if c.is_ascii_digit() || (c == '.' && next.is_some_and(|n| n.is_ascii_digit())) {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' && !matches!(chars.get(i + 1), Some('*' | '/' | '^')) {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < chars.len() && matches!(chars[i], 'e' | 'E') {
                let mut j = i + 1;
                if matches!(chars.get(j), Some('+' | '-')) {
                    j += 1;
                }
                if chars.get(j).is_some_and(|d| d.is_ascii_digit()) {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            let text: String = chars[start..i].iter().collect();
            let value = text.parse::<f64>().map_err(|_| Error::Expression(format!("invalid number `{text}`")))?;
            tokens.push(Token::Number(value));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            tokens.push(Token::Identifier(chars[start..i].iter().collect()));
            continue;
        }
        return Err(Error::Expression(format!("unexpected character `{c}` at position {i} in `{source}`")));
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
    params: Vec<String>,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn eat(&mut self, token: &Token) -> bool {
        if self.peek() == Some(token) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, token: &Token) -> Result<()> {
        if self.eat(token) {
            Ok(())
        } else {
            Err(self.unexpected(&format!("`{token}`")))
        }
    }

    fn unexpected(&self, wanted: &str) -> Error {
        match self.peek() {
            Some(found) => Error::Expression(format!("expected {wanted}, found `{found}`")),
            None => Error::Expression(format!("expected {wanted}, found the end of the expression")),
        }
    }

    fn identifier(&mut self) -> Result<String> {
        match self.peek() {
            Some(Token::Identifier(name)) => {
                let name = name.clone();
                self.position += 1;
                Ok(name)
            }
            _ => Err(self.unexpected("a name")),
        }
    }

    fn expression(&mut self) -> Result<Expr> {
        let mut left = self.term()?;
        loop {
            let op = match self.peek() {
                Some(Token::Plus) => BinaryOp::Add,
                Some(Token::Minus) => BinaryOp::Subtract,
                _ => return Ok(left),
            };
            self.position += 1;
            let right = self.term()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
    }

    fn term(&mut self) -> Result<Expr> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(Token::Star) => BinaryOp::Multiply,
                Some(Token::Slash) => BinaryOp::Divide,
                Some(Token::DotStar) => BinaryOp::ElementMultiply,
                Some(Token::DotSlash) => BinaryOp::ElementDivide,
                _ => return Ok(left),
            };
            self.position += 1;
            let right = self.unary()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
    }

    fn unary(&mut self) -> Result<Expr> {
        if self.eat(&Token::Minus) {
            return Ok(Expr::Negate(Box::new(self.unary()?)));
        }
        if self.eat(&Token::Plus) {
            return self.unary();
        }
        self.power()
    }

    fn power(&mut self) -> Result<Expr> {
        let mut left = self.primary()?;
        loop {
            let op = match self.peek() {
                Some(Token::Caret) => BinaryOp::Power,
                Some(Token::DotCaret) => BinaryOp::ElementPower,
                _ => return Ok(left),
            };
            self.position += 1;
            let right = self.power_operand()?;
            left = Expr::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
    }

    /// The exponent may carry its own sign (`2^-1`), but not another power: `2^3^2` is `(2^3)^2`.
    fn power_operand(&mut self) -> Result<Expr> {
        if self.eat(&Token::Minus) {
            return Ok(Expr::Negate(Box::new(self.power_operand()?)));
        }
        if self.eat(&Token::Plus) {
            return self.power_operand();
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Expr> {
        match self.peek().cloned() {
            Some(Token::Number(value)) => {
                self.position += 1;
                Ok(Expr::Number(value))
            }
            Some(Token::LeftParen) => {
                self.position += 1;
                let inner = self.expression()?;
                self.expect(&Token::RightParen)?;
                Ok(inner)
            }
            Some(Token::LeftBracket) => {
                self.position += 1;
                self.concatenation()
            }
            Some(Token::Identifier(name)) => {
                self.position += 1;
                if self.params.contains(&name) {
                    self.indexed(name)
                } else if self.eat(&Token::LeftParen) {
                    let args = self.arguments()?;
                    Ok(Expr::Call { function: name, args })
                } else if name == "pi" {
                    Ok(Expr::Pi)
                } else {
                    Err(Error::Expression(format!("unknown variable `{name}`")))
                }
            }
            _ => Err(self.unexpected("a number, a name, `(` or `[`")),
        }
    }

    fn indexed(&mut self, variable: String) -> Result<Expr> {
        if !self.eat(&Token::LeftParen) {
            return Ok(Expr::Variable(variable));
        }
        let from = self.expression()?;
        let to = if self.eat(&Token::Colon) { Some(Box::new(self.expression()?)) } else { None };
        self.expect(&Token::RightParen)?;
        Ok(Expr::Index { variable, from: Box::new(from), to })
    }

    fn arguments(&mut self) -> Result<Vec<Expr>> {
        let mut args = Vec::new();
        if self.eat(&Token::RightParen) {
            return Ok(args);
        }
        loop {
            args.push(self.expression()?);
            if self.eat(&Token::RightParen) {
                return Ok(args);
            }
            self.expect(&Token::Comma)?;
        }
    }

    fn concatenation(&mut self) -> Result<Expr> {
        let mut blocks = Vec::new();
        if self.eat(&Token::RightBracket) {
            return Ok(Expr::VerticalConcat(blocks));
        }
        loop {
            blocks.push(self.expression()?);
            if self.eat(&Token::RightBracket) {
                return Ok(Expr::VerticalConcat(blocks));
            }
            if self.eat(&Token::Comma) {
                return Err(Error::Expression("horizontal concatenation `[a, b]` is not supported; stack with `;`".into()));
            }
            self.expect(&Token::Semicolon)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eval(source: &str, args: &[Value]) -> Result<Value> {
        AnonymousFunction::parse(source)?.evaluate(args)
    }

    fn scalar(source: &str) -> f64 {
        eval(source, &[]).unwrap().as_scalar().unwrap()
    }

    fn assert_close(actual: f64, expected: f64) {
        let tolerance = 1e-12 * expected.abs().max(1e-300);
        assert!((actual - expected).abs() <= tolerance, "{actual} != {expected}");
    }

    #[test]
    fn parses_header_and_keeps_source() {
        let function = AnonymousFunction::parse("@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)").unwrap();
        assert_eq!(function.source, "@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)");
        assert_eq!(function.params, vec!["P", "ApWidth"]);
        match &function.body {
            Expr::Call { function, args } => {
                assert_eq!(function, "prf_gaussian_rf");
                assert_eq!(args.len(), 4);
                assert_eq!(args[3], Expr::Variable("ApWidth".into()));
            }
            other => panic!("unexpected body {other:?}"),
        }
    }

    #[test]
    fn precedence_matches_octave() {
        let expected = [-4.0, 0.5, 64.0, -0.25, -4.0, 2.0, 18.0, 6.0];
        let sources = ["@()-2^2", "@()2^-1", "@()2^3^2", "@()-2^-2", "@()1-2-3", "@()8/2/2", "@()2*3^2", "@()-3*-2"];
        for (source, expected) in sources.iter().zip(expected) {
            assert_eq!(scalar(source), expected, "{source}");
        }
    }

    #[test]
    fn numbers_and_pi() {
        assert_eq!(scalar("@() 1.5e2 + .5 + 2e-1 + 3."), 153.7);
        assert_close(scalar("@() 2*pi"), 2.0 * std::f64::consts::PI);
    }

    #[test]
    fn seed_parameter_function() {
        let result = eval("@(V) [V(2:3); V(4)/(2*sqrt(2*log(2)))]", &[Value::column(vec![1.0, 2.0, 3.0, 4.0])]).unwrap();
        assert_eq!(result.rows, 3);
        assert_eq!(result.cols, 1);
        assert_eq!(result.data[0], 2.0);
        assert_eq!(result.data[1], 3.0);
        assert_close(result.data[2], 1.6986436005760381);
    }

    #[test]
    fn index_errors_name_variable_and_index() {
        let error = eval("@(P) P(5)", &[Value::column(vec![1.0, 2.0])]).unwrap_err();
        assert_eq!(error, Error::Expression("index 5 out of range for `P` with 2 elements".into()));
        let error = eval("@(P) P(0)", &[Value::column(vec![1.0])]).unwrap_err();
        assert_eq!(error, Error::Expression("index 0 into `P` is not a positive integer".into()));
    }

    #[test]
    fn unknown_names_fail_by_name() {
        assert_eq!(AnonymousFunction::parse("@(P) Q + 1").unwrap_err(), Error::Expression("unknown variable `Q`".into()));
        let error = eval("@(P) Q(1)", &[Value::scalar(1.0)]).unwrap_err();
        assert_eq!(error, Error::Expression("unknown function `Q`".into()));
        let error = eval("@(P) frobnicate(P(1))", &[Value::scalar(1.0)]).unwrap_err();
        assert!(error.to_string().contains("frobnicate"), "{error}");
    }

    #[test]
    fn argument_count_is_checked() {
        let error = eval("@(P,ApWidth) P(1)", &[Value::scalar(1.0)]).unwrap_err();
        assert_eq!(error, Error::Expression("`@(P,ApWidth) P(1)` takes 2 argument(s), 1 given".into()));
    }

    #[test]
    fn horizontal_concatenation_is_refused() {
        let error = AnonymousFunction::parse("@(P) [P(1), P(2)]").unwrap_err();
        assert!(error.to_string().contains("horizontal concatenation"), "{error}");
    }

    #[test]
    fn broadcasting_and_elementwise_operators() {
        let column = Value::column(vec![1.0, 2.0, 3.0]);
        let result = eval("@(V) 2 .* V .^ 2 ./ V - 1", std::slice::from_ref(&column)).unwrap();
        assert_eq!(result.data, vec![1.0, 3.0, 5.0]);
        let result = eval("@(V) 10 - V", std::slice::from_ref(&column)).unwrap();
        assert_eq!(result.data, vec![9.0, 8.0, 7.0]);
        let error = eval("@(V) V .* V(1:2)", std::slice::from_ref(&column)).unwrap_err();
        assert!(error.to_string().contains("dimensions must agree"), "{error}");
        let error = eval("@(V) V ^ 2", std::slice::from_ref(&column)).unwrap_err();
        assert!(error.to_string().contains("matrix power"), "{error}");
        let error = eval("@(V) 1 / V", &[column]).unwrap_err();
        assert!(error.to_string().contains("matrix division"), "{error}");
    }

    #[test]
    fn matrix_product_uses_inner_dimension() {
        let row = Value { rows: 1, cols: 3, data: vec![1.0, 2.0, 3.0] };
        let column = Value::column(vec![4.0, 5.0, 6.0]);
        let result = eval("@(R,C) R * C", &[row.clone(), column.clone()]).unwrap();
        assert_eq!(result, Value::scalar(32.0));
        let outer = eval("@(R,C) C * R", &[row.clone(), column.clone()]).unwrap();
        assert_eq!(outer.rows, 3);
        assert_eq!(outer.cols, 3);
        assert_eq!(outer.data[3], 8.0);
        let error = eval("@(C) C * C", &[column]).unwrap_err();
        assert!(error.to_string().contains("inner matrix dimensions"), "{error}");
    }

    #[test]
    fn range_on_a_row_stays_a_row() {
        let row = Value { rows: 1, cols: 4, data: vec![1.0, 2.0, 3.0, 4.0] };
        let result = eval("@(R) R(2:3)", &[row]).unwrap();
        assert_eq!(result, Value { rows: 1, cols: 2, data: vec![2.0, 3.0] });
    }

    #[test]
    fn vertical_concat_stacks_column_major() {
        let a = Value { rows: 1, cols: 2, data: vec![1.0, 2.0] };
        let b = Value { rows: 2, cols: 2, data: vec![3.0, 5.0, 4.0, 6.0] };
        let result = eval("@(A,B) [A; B]", &[a, b]).unwrap();
        assert_eq!(result, Value { rows: 3, cols: 2, data: vec![1.0, 3.0, 5.0, 2.0, 4.0, 6.0] });
    }

    #[test]
    fn parse_errors_say_what_was_expected() {
        let error = AnonymousFunction::parse("(P) P(1)").unwrap_err();
        assert_eq!(error, Error::Expression("expected `@`, found `(`".into()));
        let error = AnonymousFunction::parse("@(P) P(1").unwrap_err();
        assert_eq!(error, Error::Expression("expected `)`, found the end of the expression".into()));
        let error = AnonymousFunction::parse("@(P) P(1) P(2)").unwrap_err();
        assert_eq!(error, Error::Expression("unexpected `P` after the function body".into()));
        let error = AnonymousFunction::parse("@(P) P(1) $").unwrap_err();
        assert!(error.to_string().contains("unexpected character `$`"), "{error}");
    }
}
