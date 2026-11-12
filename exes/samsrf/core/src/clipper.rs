//! A port of the closed-path union of Clipper 6.4.2 (Angus Johnson, Boost
//! Software License; provenance and licence in `polyshape.rs`), restricted to
//! what MATLAB's `polyshape` uses: one closed subject path, even-odd filling,
//! `ctUnion`, strictly simple (`SimplifyPolygons`). Open paths, clip paths, Z values and
//! the polygon tree are left out. The floating-point arithmetic, the order of
//! operations and libstdc++'s `std::sort` tie order are kept, because the
//! vertices Clipper creates at nearly parallel crossings depend on them.

use std::collections::BinaryHeap;

pub(crate) type Point = (i64, i64);

const NIL: usize = usize::MAX;
const HORIZONTAL: f64 = -1.0e40;
const UNASSIGNED: i32 = -1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    None,
    Left,
    Right,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    RightToLeft,
    LeftToRight,
}

#[derive(Clone)]
struct Edge {
    bot: Point,
    curr: Point,
    top: Point,
    dx: f64,
    side: Side,
    wind_delta: i32,
    wind_cnt: i32,
    wind_cnt2: i32,
    out_idx: i32,
    next: usize,
    prev: usize,
    next_in_lml: usize,
    next_in_ael: usize,
    prev_in_ael: usize,
    next_in_sel: usize,
    prev_in_sel: usize,
}

#[derive(Clone, Copy)]
struct LocalMinimum {
    y: i64,
    left: usize,
    right: usize,
}

#[derive(Clone, Copy)]
struct OutPt {
    idx: i32,
    pt: Point,
    next: usize,
    prev: usize,
}

#[derive(Clone, Copy)]
struct OutRec {
    idx: i32,
    is_hole: bool,
    first_left: usize,
    pts: usize,
    bottom_pt: usize,
}

#[derive(Clone, Copy)]
struct Join {
    op1: usize,
    op2: usize,
    off: Point,
}

#[derive(Clone, Copy)]
struct IntersectNode {
    edge1: usize,
    edge2: usize,
    pt: Point,
}

/// Why `Execute` returned false.
struct Failed;

/// `Round` from clipper.cpp: truncation of `val -/+ 0.5`.
fn round(val: f64) -> i64 {
    if val < 0.0 { (val - 0.5) as i64 } else { (val + 0.5) as i64 }
}

fn slopes_equal3(p1: Point, p2: Point, p3: Point) -> bool {
    (p1.1 - p2.1) as i128 * (p2.0 - p3.0) as i128 == (p1.0 - p2.0) as i128 * (p2.1 - p3.1) as i128
}

fn slopes_equal4(p1: Point, p2: Point, p3: Point, p4: Point) -> bool {
    (p1.1 - p2.1) as i128 * (p3.0 - p4.0) as i128 == (p1.0 - p2.0) as i128 * (p3.1 - p4.1) as i128
}

fn get_dx(p1: Point, p2: Point) -> f64 {
    if p1.1 == p2.1 { HORIZONTAL } else { (p2.0 - p1.0) as f64 / (p2.1 - p1.1) as f64 }
}

fn pt2_is_between_pt1_and_pt3(p1: Point, p2: Point, p3: Point) -> bool {
    if p1 == p3 || p1 == p2 || p3 == p2 {
        false
    } else if p1.0 != p3.0 {
        (p2.0 > p1.0) == (p2.0 < p3.0)
    } else {
        (p2.1 > p1.1) == (p2.1 < p3.1)
    }
}

fn horz_segments_overlap(mut a1: i64, mut a2: i64, mut b1: i64, mut b2: i64) -> bool {
    if a1 > a2 {
        std::mem::swap(&mut a1, &mut a2);
    }
    if b1 > b2 {
        std::mem::swap(&mut b1, &mut b2);
    }
    a1 < b2 && b1 < a2
}

fn get_overlap(a1: i64, a2: i64, b1: i64, b2: i64) -> Option<(i64, i64)> {
    let (left, right) = if a1 < a2 {
        if b1 < b2 { (a1.max(b1), a2.min(b2)) } else { (a1.max(b2), a2.min(b1)) }
    } else if b1 < b2 {
        (a2.max(b1), a1.min(b2))
    } else {
        (a2.max(b2), a1.min(b1))
    };
    (left < right).then_some((left, right))
}

/// libstdc++'s `std::sort` (introsort, median-of-three, final insertion sort),
/// so that elements comparing equal end in the order GCC builds leave them.
pub(crate) fn gnu_sort<T: Copy>(v: &mut [T], less: &impl Fn(&T, &T) -> bool) {
    let n = v.len();
    if n == 0 {
        return;
    }
    let lg = usize::BITS - 1 - n.leading_zeros();
    introsort_loop(v, 0, n, 2 * lg as usize, less);
    if n > 16 {
        insertion_sort(v, 0, 16, less);
        for i in 16..n {
            unguarded_linear_insert(v, i, less);
        }
    } else {
        insertion_sort(v, 0, n, less);
    }
}

fn introsort_loop<T: Copy>(v: &mut [T], first: usize, mut last: usize, mut depth: usize, less: &impl Fn(&T, &T) -> bool) {
    while last - first > 16 {
        if depth == 0 {
            make_heap(v, first, last, less);
            let mut end = last;
            while end - first > 1 {
                end -= 1;
                let value = v[end];
                v[end] = v[first];
                adjust_heap(v, first, 0, end - first, value, less);
            }
            return;
        }
        depth -= 1;
        let mid = first + (last - first) / 2;
        move_median_to_first(v, first, first + 1, mid, last - 1, less);
        let cut = unguarded_partition(v, first + 1, last, first, less);
        introsort_loop(v, cut, last, depth, less);
        last = cut;
    }
}

fn move_median_to_first<T: Copy>(v: &mut [T], result: usize, a: usize, b: usize, c: usize, less: &impl Fn(&T, &T) -> bool) {
    let target = if less(&v[a], &v[b]) {
        if less(&v[b], &v[c]) {
            b
        } else if less(&v[a], &v[c]) {
            c
        } else {
            a
        }
    } else if less(&v[a], &v[c]) {
        a
    } else if less(&v[b], &v[c]) {
        c
    } else {
        b
    };
    v.swap(result, target);
}

fn unguarded_partition<T: Copy>(v: &mut [T], mut first: usize, mut last: usize, pivot: usize, less: &impl Fn(&T, &T) -> bool) -> usize {
    loop {
        while less(&v[first], &v[pivot]) {
            first += 1;
        }
        last -= 1;
        while less(&v[pivot], &v[last]) {
            last -= 1;
        }
        if first >= last {
            return first;
        }
        v.swap(first, last);
        first += 1;
    }
}

fn insertion_sort<T: Copy>(v: &mut [T], first: usize, last: usize, less: &impl Fn(&T, &T) -> bool) {
    if first == last {
        return;
    }
    for i in first + 1..last {
        if less(&v[i], &v[first]) {
            let value = v[i];
            v.copy_within(first..i, first + 1);
            v[first] = value;
        } else {
            unguarded_linear_insert(v, i, less);
        }
    }
}

fn unguarded_linear_insert<T: Copy>(v: &mut [T], mut last: usize, less: &impl Fn(&T, &T) -> bool) {
    let value = v[last];
    let mut next = last - 1;
    while less(&value, &v[next]) {
        v[last] = v[next];
        last = next;
        next -= 1;
    }
    v[last] = value;
}

fn make_heap<T: Copy>(v: &mut [T], first: usize, last: usize, less: &impl Fn(&T, &T) -> bool) {
    let len = last - first;
    if len < 2 {
        return;
    }
    let mut parent = (len - 2) / 2;
    loop {
        let value = v[first + parent];
        adjust_heap(v, first, parent, len, value, less);
        if parent == 0 {
            return;
        }
        parent -= 1;
    }
}

fn adjust_heap<T: Copy>(v: &mut [T], first: usize, mut hole: usize, len: usize, value: T, less: &impl Fn(&T, &T) -> bool) {
    let top = hole;
    let mut second = hole;
    while second < (len - 1) / 2 {
        second = 2 * (second + 1);
        if less(&v[first + second], &v[first + second - 1]) {
            second -= 1;
        }
        v[first + hole] = v[first + second];
        hole = second;
    }
    if len & 1 == 0 && second == (len - 2) / 2 {
        second = 2 * (second + 1);
        v[first + hole] = v[first + second - 1];
        hole = second - 1;
    }
    let mut parent = hole.wrapping_sub(1) / 2;
    while hole > top && less(&v[first + parent], &value) {
        v[first + hole] = v[first + parent];
        hole = parent;
        parent = hole.wrapping_sub(1) / 2;
    }
    v[first + hole] = value;
}

struct Clipper {
    edges: Vec<Edge>,
    minima: Vec<LocalMinimum>,
    current_lm: usize,
    scanbeam: BinaryHeap<i64>,
    active: usize,
    sorted: usize,
    out_pts: Vec<OutPt>,
    poly_outs: Vec<OutRec>,
    joins: Vec<Join>,
    ghost_joins: Vec<Join>,
    maxima: Vec<i64>,
    intersections: Vec<IntersectNode>,
}

/// `SimplifyPolygons(paths, pftEvenOdd)`: a strictly simple `Execute(ctUnion)`
/// of the closed `paths`, with the output paths as `BuildResult` lists them, or
/// `None` when `Execute` returns false.
pub(crate) fn simplify_even_odd(paths: &[Vec<Point>]) -> Option<Vec<Vec<Point>>> {
    let mut c = Clipper {
        edges: Vec::new(),
        minima: Vec::new(),
        current_lm: 0,
        scanbeam: BinaryHeap::new(),
        active: NIL,
        sorted: NIL,
        out_pts: Vec::new(),
        poly_outs: Vec::new(),
        joins: Vec::new(),
        ghost_joins: Vec::new(),
        maxima: Vec::new(),
        intersections: Vec::new(),
    };
    for path in paths {
        c.add_path(path);
    }
    if c.execute_internal().is_err() {
        return None;
    }
    Some(c.build_result())
}

impl Clipper {
    fn is_horizontal(&self, e: usize) -> bool {
        self.edges[e].dx == HORIZONTAL
    }

    fn top_x(&self, e: usize, y: i64) -> i64 {
        let edge = &self.edges[e];
        if y == edge.top.1 { edge.top.0 } else { edge.bot.0 + round(edge.dx * (y - edge.bot.1) as f64) }
    }

    fn intersect_point(&self, e1: usize, e2: usize) -> Point {
        let (a, b) = (&self.edges[e1], &self.edges[e2]);
        let mut ip: Point;
        if a.dx == b.dx {
            let y = a.curr.1;
            return (self.top_x(e1, y), y);
        } else if a.dx == 0.0 {
            ip = (a.bot.0, 0);
            if b.dx == HORIZONTAL {
                ip.1 = b.bot.1;
            } else {
                let b2 = b.bot.1 as f64 - (b.bot.0 as f64 / b.dx);
                ip.1 = round(ip.0 as f64 / b.dx + b2);
            }
        } else if b.dx == 0.0 {
            ip = (b.bot.0, 0);
            if a.dx == HORIZONTAL {
                ip.1 = a.bot.1;
            } else {
                let b1 = a.bot.1 as f64 - (a.bot.0 as f64 / a.dx);
                ip.1 = round(ip.0 as f64 / a.dx + b1);
            }
        } else {
            let b1 = a.bot.0 as f64 - a.bot.1 as f64 * a.dx;
            let b2 = b.bot.0 as f64 - b.bot.1 as f64 * b.dx;
            let q = (b2 - b1) / (a.dx - b.dx);
            ip = (0, round(q));
            ip.0 = if a.dx.abs() < b.dx.abs() { round(a.dx * q + b1) } else { round(b.dx * q + b2) };
        }
        if ip.1 < a.top.1 || ip.1 < b.top.1 {
            ip.1 = if a.top.1 > b.top.1 { a.top.1 } else { b.top.1 };
            ip.0 = if a.dx.abs() < b.dx.abs() { self.top_x(e1, ip.1) } else { self.top_x(e2, ip.1) };
        }
        if ip.1 > a.curr.1 {
            ip.1 = a.curr.1;
            ip.0 = if a.dx.abs() > b.dx.abs() { self.top_x(e2, ip.1) } else { self.top_x(e1, ip.1) };
        }
        ip
    }

    fn set_dx(&mut self, e: usize) {
        let edge = &mut self.edges[e];
        let dy = edge.top.1 - edge.bot.1;
        edge.dx = if dy == 0 { HORIZONTAL } else { (edge.top.0 - edge.bot.0) as f64 / dy as f64 };
    }

    fn reverse_horizontal(&mut self, e: usize) {
        let edge = &mut self.edges[e];
        std::mem::swap(&mut edge.top.0, &mut edge.bot.0);
    }

    fn remove_edge(&mut self, e: usize) -> usize {
        let (prev, next) = (self.edges[e].prev, self.edges[e].next);
        self.edges[prev].next = next;
        self.edges[next].prev = prev;
        self.edges[e].prev = NIL;
        next
    }

    fn add_path(&mut self, pg: &[Point]) -> bool {
        let mut high = pg.len() as isize - 1;
        while high > 0 && pg[high as usize] == pg[0] {
            high -= 1;
        }
        while high > 0 && pg[high as usize] == pg[high as usize - 1] {
            high -= 1;
        }
        if high < 2 {
            return false;
        }
        let n = high as usize + 1;
        let base = self.edges.len();
        for (i, &pt) in pg.iter().enumerate().take(n) {
            self.edges.push(Edge {
                bot: (0, 0),
                curr: pt,
                top: (0, 0),
                dx: 0.0,
                side: Side::None,
                wind_delta: 0,
                wind_cnt: 0,
                wind_cnt2: 0,
                out_idx: UNASSIGNED,
                next: base + (i + 1) % n,
                prev: base + (i + n - 1) % n,
                next_in_lml: NIL,
                next_in_ael: NIL,
                prev_in_ael: NIL,
                next_in_sel: NIL,
                prev_in_sel: NIL,
            });
        }
        // Remove duplicate vertices and collinear edges.
        let (mut e, mut start, mut loop_stop) = (base, base, base);
        loop {
            let next = self.edges[e].next;
            if self.edges[e].curr == self.edges[next].curr {
                if e == next {
                    break;
                }
                if e == start {
                    start = next;
                }
                e = self.remove_edge(e);
                loop_stop = e;
                continue;
            }
            let prev = self.edges[e].prev;
            if prev == next {
                break;
            } else if slopes_equal3(self.edges[prev].curr, self.edges[e].curr, self.edges[next].curr) {
                if e == start {
                    start = next;
                }
                e = self.remove_edge(e);
                e = self.edges[e].prev;
                loop_stop = e;
                continue;
            }
            e = next;
            if e == loop_stop {
                break;
            }
        }
        if self.edges[e].prev == self.edges[e].next {
            return false;
        }
        let mut is_flat = true;
        e = start;
        loop {
            let next = self.edges[e].next;
            let (curr, next_curr) = (self.edges[e].curr, self.edges[next].curr);
            if curr.1 >= next_curr.1 {
                self.edges[e].bot = curr;
                self.edges[e].top = next_curr;
            } else {
                self.edges[e].top = curr;
                self.edges[e].bot = next_curr;
            }
            self.set_dx(e);
            e = next;
            if is_flat && self.edges[e].curr.1 != self.edges[start].curr.1 {
                is_flat = false;
            }
            if e == start {
                break;
            }
        }
        if is_flat {
            return false;
        }
        let mut e_min = NIL;
        let prev = self.edges[e].prev;
        if self.edges[prev].bot == self.edges[prev].top {
            e = self.edges[e].next;
        }
        loop {
            e = self.find_next_loc_min(e);
            if e == e_min {
                break;
            } else if e_min == NIL {
                e_min = e;
            }
            let prev = self.edges[e].prev;
            let (left, right, left_is_forward) = if self.edges[e].dx < self.edges[prev].dx { (prev, e, false) } else { (e, prev, true) };
            let delta = if self.edges[left].next == right { -1 } else { 1 };
            self.edges[left].wind_delta = delta;
            self.edges[right].wind_delta = -delta;
            let mut e1 = self.process_bound(left, left_is_forward);
            let e2 = self.process_bound(right, !left_is_forward);
            self.minima.push(LocalMinimum { y: self.edges[e].bot.1, left, right });
            if !left_is_forward {
                e1 = e2;
            }
            e = e1;
        }
        true
    }

    fn find_next_loc_min(&self, mut e: usize) -> usize {
        loop {
            while self.edges[e].bot != self.edges[self.edges[e].prev].bot || self.edges[e].curr == self.edges[e].top {
                e = self.edges[e].next;
            }
            if !self.is_horizontal(e) && !self.is_horizontal(self.edges[e].prev) {
                break;
            }
            while self.is_horizontal(self.edges[e].prev) {
                e = self.edges[e].prev;
            }
            let e2 = e;
            while self.is_horizontal(e) {
                e = self.edges[e].next;
            }
            if self.edges[e].top.1 == self.edges[self.edges[e].prev].bot.1 {
                continue;
            }
            if self.edges[self.edges[e2].prev].bot.0 < self.edges[e].bot.0 {
                e = e2;
            }
            break;
        }
        e
    }

    fn process_bound(&mut self, mut e: usize, next_is_forward: bool) -> usize {
        let mut result = e;
        if self.is_horizontal(e) {
            let start = if next_is_forward { self.edges[e].prev } else { self.edges[e].next };
            if self.is_horizontal(start) {
                if self.edges[start].bot.0 != self.edges[e].bot.0 && self.edges[start].top.0 != self.edges[e].bot.0 {
                    self.reverse_horizontal(e);
                }
            } else if self.edges[start].bot.0 != self.edges[e].bot.0 {
                self.reverse_horizontal(e);
            }
        }
        let start = e;
        if next_is_forward {
            while self.edges[result].top.1 == self.edges[self.edges[result].next].bot.1 {
                result = self.edges[result].next;
            }
            if self.is_horizontal(result) {
                let mut horz = result;
                while self.is_horizontal(self.edges[horz].prev) {
                    horz = self.edges[horz].prev;
                }
                if self.edges[self.edges[horz].prev].top.0 > self.edges[self.edges[result].next].top.0 {
                    result = self.edges[horz].prev;
                }
            }
            while e != result {
                self.edges[e].next_in_lml = self.edges[e].next;
                if self.is_horizontal(e) && e != start && self.edges[e].bot.0 != self.edges[self.edges[e].prev].top.0 {
                    self.reverse_horizontal(e);
                }
                e = self.edges[e].next;
            }
            if self.is_horizontal(e) && e != start && self.edges[e].bot.0 != self.edges[self.edges[e].prev].top.0 {
                self.reverse_horizontal(e);
            }
            result = self.edges[result].next;
        } else {
            while self.edges[result].top.1 == self.edges[self.edges[result].prev].bot.1 {
                result = self.edges[result].prev;
            }
            if self.is_horizontal(result) {
                let mut horz = result;
                while self.is_horizontal(self.edges[horz].next) {
                    horz = self.edges[horz].next;
                }
                let (h, r) = (self.edges[self.edges[horz].next].top.0, self.edges[self.edges[result].prev].top.0);
                if h >= r {
                    result = self.edges[horz].next;
                }
            }
            while e != result {
                self.edges[e].next_in_lml = self.edges[e].prev;
                if self.is_horizontal(e) && e != start && self.edges[e].bot.0 != self.edges[self.edges[e].next].top.0 {
                    self.reverse_horizontal(e);
                }
                e = self.edges[e].prev;
            }
            if self.is_horizontal(e) && e != start && self.edges[e].bot.0 != self.edges[self.edges[e].next].top.0 {
                self.reverse_horizontal(e);
            }
            result = self.edges[result].prev;
        }
        result
    }

    fn reset(&mut self) {
        self.current_lm = 0;
        if self.minima.is_empty() {
            return;
        }
        gnu_sort(&mut self.minima, &|a: &LocalMinimum, b: &LocalMinimum| b.y < a.y);
        self.scanbeam.clear();
        for i in 0..self.minima.len() {
            let lm = self.minima[i];
            self.scanbeam.push(lm.y);
            for (bound, side) in [(lm.left, Side::Left), (lm.right, Side::Right)] {
                if bound != NIL {
                    let edge = &mut self.edges[bound];
                    edge.curr = edge.bot;
                    edge.side = side;
                    edge.out_idx = UNASSIGNED;
                }
            }
        }
        self.active = NIL;
        self.current_lm = 0;
    }

    fn pop_scanbeam(&mut self) -> Option<i64> {
        let y = self.scanbeam.pop()?;
        while self.scanbeam.peek() == Some(&y) {
            self.scanbeam.pop();
        }
        Some(y)
    }

    fn delete_from_ael(&mut self, e: usize) {
        let (prev, next) = (self.edges[e].prev_in_ael, self.edges[e].next_in_ael);
        if prev == NIL && next == NIL && e != self.active {
            return;
        }
        if prev != NIL {
            self.edges[prev].next_in_ael = next;
        } else {
            self.active = next;
        }
        if next != NIL {
            self.edges[next].prev_in_ael = prev;
        }
        self.edges[e].next_in_ael = NIL;
        self.edges[e].prev_in_ael = NIL;
    }

    fn create_out_rec(&mut self) -> usize {
        let idx = self.poly_outs.len();
        self.poly_outs.push(OutRec { idx: idx as i32, is_hole: false, first_left: NIL, pts: NIL, bottom_pt: NIL });
        idx
    }

    fn swap_positions_in_ael(&mut self, e1: usize, e2: usize) {
        if self.edges[e1].next_in_ael == self.edges[e1].prev_in_ael || self.edges[e2].next_in_ael == self.edges[e2].prev_in_ael {
            return;
        }
        if self.edges[e1].next_in_ael == e2 {
            let next = self.edges[e2].next_in_ael;
            if next != NIL {
                self.edges[next].prev_in_ael = e1;
            }
            let prev = self.edges[e1].prev_in_ael;
            if prev != NIL {
                self.edges[prev].next_in_ael = e2;
            }
            self.edges[e2].prev_in_ael = prev;
            self.edges[e2].next_in_ael = e1;
            self.edges[e1].prev_in_ael = e2;
            self.edges[e1].next_in_ael = next;
        } else if self.edges[e2].next_in_ael == e1 {
            let next = self.edges[e1].next_in_ael;
            if next != NIL {
                self.edges[next].prev_in_ael = e2;
            }
            let prev = self.edges[e2].prev_in_ael;
            if prev != NIL {
                self.edges[prev].next_in_ael = e1;
            }
            self.edges[e1].prev_in_ael = prev;
            self.edges[e1].next_in_ael = e2;
            self.edges[e2].prev_in_ael = e1;
            self.edges[e2].next_in_ael = next;
        } else {
            let next = self.edges[e1].next_in_ael;
            let prev = self.edges[e1].prev_in_ael;
            self.edges[e1].next_in_ael = self.edges[e2].next_in_ael;
            if self.edges[e1].next_in_ael != NIL {
                let n = self.edges[e1].next_in_ael;
                self.edges[n].prev_in_ael = e1;
            }
            self.edges[e1].prev_in_ael = self.edges[e2].prev_in_ael;
            if self.edges[e1].prev_in_ael != NIL {
                let p = self.edges[e1].prev_in_ael;
                self.edges[p].next_in_ael = e1;
            }
            self.edges[e2].next_in_ael = next;
            if next != NIL {
                self.edges[next].prev_in_ael = e2;
            }
            self.edges[e2].prev_in_ael = prev;
            if prev != NIL {
                self.edges[prev].next_in_ael = e2;
            }
        }
        if self.edges[e1].prev_in_ael == NIL {
            self.active = e1;
        } else if self.edges[e2].prev_in_ael == NIL {
            self.active = e2;
        }
    }

    fn swap_positions_in_sel(&mut self, e1: usize, e2: usize) {
        if self.edges[e1].next_in_sel == NIL && self.edges[e1].prev_in_sel == NIL {
            return;
        }
        if self.edges[e2].next_in_sel == NIL && self.edges[e2].prev_in_sel == NIL {
            return;
        }
        if self.edges[e1].next_in_sel == e2 {
            let next = self.edges[e2].next_in_sel;
            if next != NIL {
                self.edges[next].prev_in_sel = e1;
            }
            let prev = self.edges[e1].prev_in_sel;
            if prev != NIL {
                self.edges[prev].next_in_sel = e2;
            }
            self.edges[e2].prev_in_sel = prev;
            self.edges[e2].next_in_sel = e1;
            self.edges[e1].prev_in_sel = e2;
            self.edges[e1].next_in_sel = next;
        } else if self.edges[e2].next_in_sel == e1 {
            let next = self.edges[e1].next_in_sel;
            if next != NIL {
                self.edges[next].prev_in_sel = e2;
            }
            let prev = self.edges[e2].prev_in_sel;
            if prev != NIL {
                self.edges[prev].next_in_sel = e1;
            }
            self.edges[e1].prev_in_sel = prev;
            self.edges[e1].next_in_sel = e2;
            self.edges[e2].prev_in_sel = e1;
            self.edges[e2].next_in_sel = next;
        } else {
            let next = self.edges[e1].next_in_sel;
            let prev = self.edges[e1].prev_in_sel;
            self.edges[e1].next_in_sel = self.edges[e2].next_in_sel;
            if self.edges[e1].next_in_sel != NIL {
                let n = self.edges[e1].next_in_sel;
                self.edges[n].prev_in_sel = e1;
            }
            self.edges[e1].prev_in_sel = self.edges[e2].prev_in_sel;
            if self.edges[e1].prev_in_sel != NIL {
                let p = self.edges[e1].prev_in_sel;
                self.edges[p].next_in_sel = e1;
            }
            self.edges[e2].next_in_sel = next;
            if next != NIL {
                self.edges[next].prev_in_sel = e2;
            }
            self.edges[e2].prev_in_sel = prev;
            if prev != NIL {
                self.edges[prev].next_in_sel = e2;
            }
        }
        if self.edges[e1].prev_in_sel == NIL {
            self.sorted = e1;
        } else if self.edges[e2].prev_in_sel == NIL {
            self.sorted = e2;
        }
    }

    fn update_edge_into_ael(&mut self, e: usize) -> Result<usize, Failed> {
        let next_lml = self.edges[e].next_in_lml;
        if next_lml == NIL {
            return Err(Failed);
        }
        let (out_idx, side, wind_delta, wind_cnt, wind_cnt2) = {
            let edge = &self.edges[e];
            (edge.out_idx, edge.side, edge.wind_delta, edge.wind_cnt, edge.wind_cnt2)
        };
        self.edges[next_lml].out_idx = out_idx;
        let (prev, next) = (self.edges[e].prev_in_ael, self.edges[e].next_in_ael);
        if prev != NIL {
            self.edges[prev].next_in_ael = next_lml;
        } else {
            self.active = next_lml;
        }
        if next != NIL {
            self.edges[next].prev_in_ael = next_lml;
        }
        let edge = &mut self.edges[next_lml];
        edge.side = side;
        edge.wind_delta = wind_delta;
        edge.wind_cnt = wind_cnt;
        edge.wind_cnt2 = wind_cnt2;
        edge.curr = edge.bot;
        edge.prev_in_ael = prev;
        edge.next_in_ael = next;
        if !self.is_horizontal(next_lml) {
            self.scanbeam.push(self.edges[next_lml].top.1);
        }
        Ok(next_lml)
    }

    fn execute_internal(&mut self) -> Result<(), Failed> {
        self.reset();
        self.maxima.clear();
        self.sorted = NIL;
        let Some(mut bot_y) = self.pop_scanbeam() else { return Err(Failed) };
        self.insert_local_minima_into_ael(bot_y);
        loop {
            let top_y = match self.pop_scanbeam() {
                Some(y) => y,
                // Clipper's loop keeps the previous topY, which is bot_y here.
                None if self.current_lm < self.minima.len() => bot_y,
                None => break,
            };
            self.process_horizontals()?;
            self.ghost_joins.clear();
            if !self.process_intersections(top_y)? {
                return Err(Failed);
            }
            self.process_edges_at_top_of_scanbeam(top_y)?;
            bot_y = top_y;
            self.insert_local_minima_into_ael(bot_y);
        }
        for i in 0..self.poly_outs.len() {
            let rec = self.poly_outs[i];
            if rec.pts == NIL {
                continue;
            }
            if rec.is_hole == (self.area(rec.pts) > 0.0) {
                self.reverse_poly_pt_links(rec.pts);
            }
        }
        if !self.joins.is_empty() {
            self.join_common_edges();
        }
        for i in 0..self.poly_outs.len() {
            if self.poly_outs[i].pts == NIL {
                continue;
            }
            self.fixup_out_polygon(i);
        }
        self.do_simple_polygons();
        Ok(())
    }

    fn set_winding_count(&mut self, edge: usize) {
        let mut e = self.edges[edge].prev_in_ael;
        while e != NIL && self.edges[e].wind_delta == 0 {
            e = self.edges[e].prev_in_ael;
        }
        if e == NIL {
            self.edges[edge].wind_cnt = self.edges[edge].wind_delta;
            self.edges[edge].wind_cnt2 = 0;
            e = self.active;
        } else {
            self.edges[edge].wind_cnt = self.edges[edge].wind_delta;
            self.edges[edge].wind_cnt2 = self.edges[e].wind_cnt2;
            e = self.edges[e].next_in_ael;
        }
        while e != edge {
            if self.edges[e].wind_delta != 0 {
                self.edges[edge].wind_cnt2 = if self.edges[edge].wind_cnt2 == 0 { 1 } else { 0 };
            }
            e = self.edges[e].next_in_ael;
        }
    }

    /// Even-odd union of subject edges only: closed edges always contribute.
    fn is_contributing(&self, edge: usize) -> bool {
        self.edges[edge].wind_cnt2 == 0
    }

    fn add_local_min_poly(&mut self, e1: usize, e2: usize, pt: Point) -> usize {
        let (result, e, prev_e);
        if self.is_horizontal(e2) || self.edges[e1].dx > self.edges[e2].dx {
            result = self.add_out_pt(e1, pt);
            self.edges[e2].out_idx = self.edges[e1].out_idx;
            self.edges[e1].side = Side::Left;
            self.edges[e2].side = Side::Right;
            e = e1;
            prev_e = if self.edges[e].prev_in_ael == e2 { self.edges[e2].prev_in_ael } else { self.edges[e].prev_in_ael };
        } else {
            result = self.add_out_pt(e2, pt);
            self.edges[e1].out_idx = self.edges[e2].out_idx;
            self.edges[e1].side = Side::Right;
            self.edges[e2].side = Side::Left;
            e = e2;
            prev_e = if self.edges[e].prev_in_ael == e1 { self.edges[e1].prev_in_ael } else { self.edges[e].prev_in_ael };
        }
        if prev_e != NIL && self.edges[prev_e].out_idx >= 0 && self.edges[prev_e].top.1 < pt.1 && self.edges[e].top.1 < pt.1 {
            let x_prev = self.top_x(prev_e, pt.1);
            let x_e = self.top_x(e, pt.1);
            if x_prev == x_e && self.edges[e].wind_delta != 0 && self.edges[prev_e].wind_delta != 0
                && slopes_equal4((x_prev, pt.1), self.edges[prev_e].top, (x_e, pt.1), self.edges[e].top)
            {
                let out = self.add_out_pt(prev_e, pt);
                let off = self.edges[e].top;
                self.joins.push(Join { op1: result, op2: out, off });
            }
        }
        result
    }

    fn add_local_max_poly(&mut self, e1: usize, e2: usize, pt: Point) {
        self.add_out_pt(e1, pt);
        if self.edges[e2].wind_delta == 0 {
            self.add_out_pt(e2, pt);
        }
        if self.edges[e1].out_idx == self.edges[e2].out_idx {
            self.edges[e1].out_idx = UNASSIGNED;
            self.edges[e2].out_idx = UNASSIGNED;
        } else if self.edges[e1].out_idx < self.edges[e2].out_idx {
            self.append_polygon(e1, e2);
        } else {
            self.append_polygon(e2, e1);
        }
    }

    fn add_edge_to_sel(&mut self, edge: usize) {
        if self.sorted == NIL {
            self.sorted = edge;
            self.edges[edge].prev_in_sel = NIL;
            self.edges[edge].next_in_sel = NIL;
        } else {
            self.edges[edge].next_in_sel = self.sorted;
            self.edges[edge].prev_in_sel = NIL;
            let s = self.sorted;
            self.edges[s].prev_in_sel = edge;
            self.sorted = edge;
        }
    }

    fn pop_edge_from_sel(&mut self) -> Option<usize> {
        if self.sorted == NIL {
            return None;
        }
        let edge = self.sorted;
        self.delete_from_sel(edge);
        Some(edge)
    }

    fn delete_from_sel(&mut self, e: usize) {
        let (prev, next) = (self.edges[e].prev_in_sel, self.edges[e].next_in_sel);
        if prev == NIL && next == NIL && e != self.sorted {
            return;
        }
        if prev != NIL {
            self.edges[prev].next_in_sel = next;
        } else {
            self.sorted = next;
        }
        if next != NIL {
            self.edges[next].prev_in_sel = prev;
        }
        self.edges[e].next_in_sel = NIL;
        self.edges[e].prev_in_sel = NIL;
    }

    fn copy_ael_to_sel(&mut self) {
        let mut e = self.active;
        self.sorted = e;
        while e != NIL {
            self.edges[e].prev_in_sel = self.edges[e].prev_in_ael;
            self.edges[e].next_in_sel = self.edges[e].next_in_ael;
            e = self.edges[e].next_in_ael;
        }
    }

    fn e2_inserts_before_e1(&self, e1: usize, e2: usize) -> bool {
        let (a, b) = (&self.edges[e1], &self.edges[e2]);
        if b.curr.0 == a.curr.0 {
            if b.top.1 > a.top.1 { b.top.0 < self.top_x(e1, b.top.1) } else { a.top.0 > self.top_x(e2, a.top.1) }
        } else {
            b.curr.0 < a.curr.0
        }
    }

    fn insert_edge_into_ael(&mut self, edge: usize, start_edge: usize) {
        if self.active == NIL {
            self.edges[edge].prev_in_ael = NIL;
            self.edges[edge].next_in_ael = NIL;
            self.active = edge;
        } else if start_edge == NIL && self.e2_inserts_before_e1(self.active, edge) {
            self.edges[edge].prev_in_ael = NIL;
            self.edges[edge].next_in_ael = self.active;
            let a = self.active;
            self.edges[a].prev_in_ael = edge;
            self.active = edge;
        } else {
            let mut start = if start_edge == NIL { self.active } else { start_edge };
            while self.edges[start].next_in_ael != NIL && !self.e2_inserts_before_e1(self.edges[start].next_in_ael, edge) {
                start = self.edges[start].next_in_ael;
            }
            let next = self.edges[start].next_in_ael;
            self.edges[edge].next_in_ael = next;
            if next != NIL {
                self.edges[next].prev_in_ael = edge;
            }
            self.edges[edge].prev_in_ael = start;
            self.edges[start].next_in_ael = edge;
        }
    }

    fn insert_local_minima_into_ael(&mut self, bot_y: i64) {
        while self.current_lm < self.minima.len() && self.minima[self.current_lm].y == bot_y {
            let lm = self.minima[self.current_lm];
            self.current_lm += 1;
            let (lb, rb) = (lm.left, lm.right);
            self.insert_edge_into_ael(lb, NIL);
            self.insert_edge_into_ael(rb, lb);
            self.set_winding_count(lb);
            self.edges[rb].wind_cnt = self.edges[lb].wind_cnt;
            self.edges[rb].wind_cnt2 = self.edges[lb].wind_cnt2;
            let mut op1 = NIL;
            if self.is_contributing(lb) {
                op1 = self.add_local_min_poly(lb, rb, self.edges[lb].bot);
            }
            self.scanbeam.push(self.edges[lb].top.1);
            if self.is_horizontal(rb) {
                self.add_edge_to_sel(rb);
                let next = self.edges[rb].next_in_lml;
                if next != NIL {
                    self.scanbeam.push(self.edges[next].top.1);
                }
            } else {
                self.scanbeam.push(self.edges[rb].top.1);
            }
            if op1 != NIL && self.is_horizontal(rb) && !self.ghost_joins.is_empty() && self.edges[rb].wind_delta != 0 {
                for i in 0..self.ghost_joins.len() {
                    let jr = self.ghost_joins[i];
                    if horz_segments_overlap(self.out_pts[jr.op1].pt.0, jr.off.0, self.edges[rb].bot.0, self.edges[rb].top.0) {
                        self.joins.push(Join { op1: jr.op1, op2: op1, off: jr.off });
                    }
                }
            }
            let lb_prev = self.edges[lb].prev_in_ael;
            if self.edges[lb].out_idx >= 0 && lb_prev != NIL && self.edges[lb_prev].curr.0 == self.edges[lb].bot.0
                && self.edges[lb_prev].out_idx >= 0
                && slopes_equal4(self.edges[lb_prev].bot, self.edges[lb_prev].top, self.edges[lb].curr, self.edges[lb].top)
                && self.edges[lb].wind_delta != 0 && self.edges[lb_prev].wind_delta != 0
            {
                let op2 = self.add_out_pt(lb_prev, self.edges[lb].bot);
                let off = self.edges[lb].top;
                self.joins.push(Join { op1, op2, off });
            }
            if self.edges[lb].next_in_ael != rb {
                let rb_prev = self.edges[rb].prev_in_ael;
                if self.edges[rb].out_idx >= 0 && self.edges[rb_prev].out_idx >= 0
                    && slopes_equal4(self.edges[rb_prev].curr, self.edges[rb_prev].top, self.edges[rb].curr, self.edges[rb].top)
                    && self.edges[rb].wind_delta != 0 && self.edges[rb_prev].wind_delta != 0
                {
                    let op2 = self.add_out_pt(rb_prev, self.edges[rb].bot);
                    let off = self.edges[rb].top;
                    self.joins.push(Join { op1, op2, off });
                }
                let mut e = self.edges[lb].next_in_ael;
                if e != NIL {
                    while e != rb {
                        let pt = self.edges[lb].curr;
                        self.intersect_edges(rb, e, pt);
                        e = self.edges[e].next_in_ael;
                    }
                }
            }
        }
    }

    fn intersect_edges(&mut self, e1: usize, e2: usize, pt: Point) {
        let e1_contributing = self.edges[e1].out_idx >= 0;
        let e2_contributing = self.edges[e2].out_idx >= 0;
        // Same polytype, even-odd: swap the winding counts.
        let old = self.edges[e1].wind_cnt;
        self.edges[e1].wind_cnt = self.edges[e2].wind_cnt;
        self.edges[e2].wind_cnt = old;
        let e1_wc = self.edges[e1].wind_cnt.abs();
        let e2_wc = self.edges[e2].wind_cnt.abs();
        if e1_contributing && e2_contributing {
            if (e1_wc != 0 && e1_wc != 1) || (e2_wc != 0 && e2_wc != 1) {
                self.add_local_max_poly(e1, e2, pt);
            } else {
                self.add_out_pt(e1, pt);
                self.add_out_pt(e2, pt);
                self.swap_sides(e1, e2);
                self.swap_poly_indexes(e1, e2);
            }
        } else if e1_contributing {
            if e2_wc == 0 || e2_wc == 1 {
                self.add_out_pt(e1, pt);
                self.swap_sides(e1, e2);
                self.swap_poly_indexes(e1, e2);
            }
        } else if e2_contributing {
            if e1_wc == 0 || e1_wc == 1 {
                self.add_out_pt(e2, pt);
                self.swap_sides(e1, e2);
                self.swap_poly_indexes(e1, e2);
            }
        } else if (e1_wc == 0 || e1_wc == 1) && (e2_wc == 0 || e2_wc == 1) {
            let e1_wc2 = self.edges[e1].wind_cnt2.abs();
            let e2_wc2 = self.edges[e2].wind_cnt2.abs();
            if e1_wc == 1 && e2_wc == 1 {
                if e1_wc2 <= 0 && e2_wc2 <= 0 {
                    self.add_local_min_poly(e1, e2, pt);
                }
            } else {
                self.swap_sides(e1, e2);
            }
        }
    }

    fn swap_sides(&mut self, e1: usize, e2: usize) {
        let s = self.edges[e1].side;
        self.edges[e1].side = self.edges[e2].side;
        self.edges[e2].side = s;
    }

    fn swap_poly_indexes(&mut self, e1: usize, e2: usize) {
        let s = self.edges[e1].out_idx;
        self.edges[e1].out_idx = self.edges[e2].out_idx;
        self.edges[e2].out_idx = s;
    }

    fn set_hole_state(&mut self, e: usize, rec: usize) {
        let mut e2 = self.edges[e].prev_in_ael;
        let mut tmp = NIL;
        while e2 != NIL {
            if self.edges[e2].out_idx >= 0 && self.edges[e2].wind_delta != 0 {
                if tmp == NIL {
                    tmp = e2;
                } else if self.edges[tmp].out_idx == self.edges[e2].out_idx {
                    tmp = NIL;
                }
            }
            e2 = self.edges[e2].prev_in_ael;
        }
        if tmp == NIL {
            self.poly_outs[rec].first_left = NIL;
            self.poly_outs[rec].is_hole = false;
        } else {
            let fl = self.edges[tmp].out_idx as usize;
            self.poly_outs[rec].first_left = fl;
            self.poly_outs[rec].is_hole = !self.poly_outs[fl].is_hole;
        }
    }

    fn first_is_bottom_pt(&self, btm1: usize, btm2: usize) -> bool {
        let dxs = |btm: usize| {
            let o = &self.out_pts;
            let mut p = o[btm].prev;
            while o[p].pt == o[btm].pt && p != btm {
                p = o[p].prev;
            }
            let dp = get_dx(o[btm].pt, o[p].pt).abs();
            p = o[btm].next;
            while o[p].pt == o[btm].pt && p != btm {
                p = o[p].next;
            }
            (dp, get_dx(o[btm].pt, o[p].pt).abs())
        };
        let (dx1p, dx1n) = dxs(btm1);
        let (dx2p, dx2n) = dxs(btm2);
        if dx1p.max(dx1n) == dx2p.max(dx2n) && dx1p.min(dx1n) == dx2p.min(dx2n) {
            self.area(btm1) > 0.0
        } else {
            (dx1p >= dx2p && dx1p >= dx2n) || (dx1n >= dx2p && dx1n >= dx2n)
        }
    }

    fn get_bottom_pt(&self, mut pp: usize) -> usize {
        let o = &self.out_pts;
        let mut dups = NIL;
        let mut p = o[pp].next;
        while p != pp {
            if o[p].pt.1 > o[pp].pt.1 {
                pp = p;
                dups = NIL;
            } else if o[p].pt.1 == o[pp].pt.1 && o[p].pt.0 <= o[pp].pt.0 {
                if o[p].pt.0 < o[pp].pt.0 {
                    dups = NIL;
                    pp = p;
                } else if o[p].next != pp && o[p].prev != pp {
                    dups = p;
                }
            }
            p = o[p].next;
        }
        if dups != NIL {
            while dups != p {
                if !self.first_is_bottom_pt(p, dups) {
                    pp = dups;
                }
                dups = o[dups].next;
                while o[dups].pt != o[pp].pt {
                    dups = o[dups].next;
                }
            }
        }
        pp
    }

    fn get_lowermost_rec(&mut self, r1: usize, r2: usize) -> usize {
        if self.poly_outs[r1].bottom_pt == NIL {
            self.poly_outs[r1].bottom_pt = self.get_bottom_pt(self.poly_outs[r1].pts);
        }
        if self.poly_outs[r2].bottom_pt == NIL {
            self.poly_outs[r2].bottom_pt = self.get_bottom_pt(self.poly_outs[r2].pts);
        }
        let (p1, p2) = (self.poly_outs[r1].bottom_pt, self.poly_outs[r2].bottom_pt);
        let (a, b) = (self.out_pts[p1].pt, self.out_pts[p2].pt);
        let first = if a.1 != b.1 {
            a.1 > b.1
        } else if a.0 != b.0 {
            a.0 < b.0
        } else if self.out_pts[p1].next == p1 || self.out_pts[p2].next == p2 {
            self.out_pts[p1].next != p1
        } else {
            self.first_is_bottom_pt(p1, p2)
        };
        if first { r1 } else { r2 }
    }

    fn rec1_right_of_rec2(&self, mut r1: usize, r2: usize) -> bool {
        loop {
            r1 = self.poly_outs[r1].first_left;
            if r1 == r2 {
                return true;
            }
            if r1 == NIL {
                return false;
            }
        }
    }

    fn get_out_rec(&self, idx: i32) -> usize {
        let mut rec = idx as usize;
        while rec != self.poly_outs[rec].idx as usize {
            rec = self.poly_outs[rec].idx as usize;
        }
        rec
    }

    fn append_polygon(&mut self, e1: usize, e2: usize) {
        let r1 = self.edges[e1].out_idx as usize;
        let r2 = self.edges[e2].out_idx as usize;
        let hole_state_rec = if self.rec1_right_of_rec2(r1, r2) {
            r2
        } else if self.rec1_right_of_rec2(r2, r1) {
            r1
        } else {
            self.get_lowermost_rec(r1, r2)
        };
        let p1_lft = self.poly_outs[r1].pts;
        let p1_rt = self.out_pts[p1_lft].prev;
        let p2_lft = self.poly_outs[r2].pts;
        let p2_rt = self.out_pts[p2_lft].prev;
        let o = &mut self.out_pts;
        if self.edges[e1].side == Side::Left {
            if self.edges[e2].side == Side::Left {
                reverse_links(o, p2_lft);
                o[p2_lft].next = p1_lft;
                o[p1_lft].prev = p2_lft;
                o[p1_rt].next = p2_rt;
                o[p2_rt].prev = p1_rt;
                self.poly_outs[r1].pts = p2_rt;
            } else {
                o[p2_rt].next = p1_lft;
                o[p1_lft].prev = p2_rt;
                o[p2_lft].prev = p1_rt;
                o[p1_rt].next = p2_lft;
                self.poly_outs[r1].pts = p2_lft;
            }
        } else if self.edges[e2].side == Side::Right {
            reverse_links(o, p2_lft);
            o[p1_rt].next = p2_rt;
            o[p2_rt].prev = p1_rt;
            o[p2_lft].next = p1_lft;
            o[p1_lft].prev = p2_lft;
        } else {
            o[p1_rt].next = p2_lft;
            o[p2_lft].prev = p1_rt;
            o[p1_lft].prev = p2_rt;
            o[p2_rt].next = p1_lft;
        }
        self.poly_outs[r1].bottom_pt = NIL;
        if hole_state_rec == r2 {
            if self.poly_outs[r2].first_left != r1 {
                self.poly_outs[r1].first_left = self.poly_outs[r2].first_left;
            }
            self.poly_outs[r1].is_hole = self.poly_outs[r2].is_hole;
        }
        self.poly_outs[r2].pts = NIL;
        self.poly_outs[r2].bottom_pt = NIL;
        self.poly_outs[r2].first_left = r1;
        let ok_idx = self.edges[e1].out_idx;
        let obsolete_idx = self.edges[e2].out_idx;
        self.edges[e1].out_idx = UNASSIGNED;
        self.edges[e2].out_idx = UNASSIGNED;
        let mut e = self.active;
        while e != NIL {
            if self.edges[e].out_idx == obsolete_idx {
                self.edges[e].out_idx = ok_idx;
                self.edges[e].side = self.edges[e1].side;
                break;
            }
            e = self.edges[e].next_in_ael;
        }
        self.poly_outs[r2].idx = self.poly_outs[r1].idx;
    }

    fn new_out_pt(&mut self, idx: i32, pt: Point) -> usize {
        let i = self.out_pts.len();
        self.out_pts.push(OutPt { idx, pt, next: i, prev: i });
        i
    }

    fn add_out_pt(&mut self, e: usize, pt: Point) -> usize {
        if self.edges[e].out_idx < 0 {
            let rec = self.create_out_rec();
            let op = self.new_out_pt(rec as i32, pt);
            self.poly_outs[rec].pts = op;
            self.set_hole_state(e, rec);
            self.edges[e].out_idx = rec as i32;
            op
        } else {
            let rec = self.edges[e].out_idx as usize;
            let op = self.poly_outs[rec].pts;
            let to_front = self.edges[e].side == Side::Left;
            if to_front && pt == self.out_pts[op].pt {
                return op;
            } else if !to_front && pt == self.out_pts[self.out_pts[op].prev].pt {
                return self.out_pts[op].prev;
            }
            let new = self.new_out_pt(self.poly_outs[rec].idx, pt);
            let prev = self.out_pts[op].prev;
            self.out_pts[new].next = op;
            self.out_pts[new].prev = prev;
            self.out_pts[prev].next = new;
            self.out_pts[op].prev = new;
            if to_front {
                self.poly_outs[rec].pts = new;
            }
            new
        }
    }

    fn get_last_out_pt(&self, e: usize) -> usize {
        let rec = &self.poly_outs[self.edges[e].out_idx as usize];
        if self.edges[e].side == Side::Left { rec.pts } else { self.out_pts[rec.pts].prev }
    }

    fn process_horizontals(&mut self) -> Result<(), Failed> {
        while let Some(horz) = self.pop_edge_from_sel() {
            self.process_horizontal(horz)?;
        }
        Ok(())
    }

    fn get_maxima_pair(&self, e: usize) -> usize {
        let edge = &self.edges[e];
        if self.edges[edge.next].top == edge.top && self.edges[edge.next].next_in_lml == NIL {
            edge.next
        } else if self.edges[edge.prev].top == edge.top && self.edges[edge.prev].next_in_lml == NIL {
            edge.prev
        } else {
            NIL
        }
    }

    fn get_maxima_pair_ex(&self, e: usize) -> usize {
        let result = self.get_maxima_pair(e);
        if result != NIL && self.edges[result].next_in_ael == self.edges[result].prev_in_ael && !self.is_horizontal(result) {
            return NIL;
        }
        result
    }

    fn horz_direction(&self, e: usize) -> (Direction, i64, i64) {
        let edge = &self.edges[e];
        if edge.bot.0 < edge.top.0 {
            (Direction::LeftToRight, edge.bot.0, edge.top.0)
        } else {
            (Direction::RightToLeft, edge.top.0, edge.bot.0)
        }
    }

    fn next_in_ael(&self, e: usize, dir: Direction) -> usize {
        if dir == Direction::LeftToRight { self.edges[e].next_in_ael } else { self.edges[e].prev_in_ael }
    }

    fn add_horizontal_joins(&mut self, horz: usize, op1: usize) {
        let mut next_horz = self.sorted;
        while next_horz != NIL {
            if self.edges[next_horz].out_idx >= 0
                && horz_segments_overlap(self.edges[horz].bot.0, self.edges[horz].top.0, self.edges[next_horz].bot.0, self.edges[next_horz].top.0)
            {
                let op2 = self.get_last_out_pt(next_horz);
                let off = self.edges[next_horz].top;
                self.joins.push(Join { op1: op2, op2: op1, off });
            }
            next_horz = self.edges[next_horz].next_in_sel;
        }
    }

    fn process_horizontal(&mut self, mut horz: usize) -> Result<(), Failed> {
        let (mut dir, mut horz_left, mut horz_right) = self.horz_direction(horz);
        let mut last_horz = horz;
        let mut max_pair = NIL;
        while self.edges[last_horz].next_in_lml != NIL && self.is_horizontal(self.edges[last_horz].next_in_lml) {
            last_horz = self.edges[last_horz].next_in_lml;
        }
        if self.edges[last_horz].next_in_lml == NIL {
            max_pair = self.get_maxima_pair(last_horz);
        }
        // Forward index into maxima, or a reverse index (count from the end).
        let mut max_it = 0usize;
        let mut max_rit = 0usize;
        let len = self.maxima.len();
        if len > 0 {
            if dir == Direction::LeftToRight {
                while max_it < len && self.maxima[max_it] <= self.edges[horz].bot.0 {
                    max_it += 1;
                }
                if max_it < len && self.maxima[max_it] >= self.edges[last_horz].top.0 {
                    max_it = len;
                }
            } else {
                while max_rit < len && self.maxima[len - 1 - max_rit] > self.edges[horz].bot.0 {
                    max_rit += 1;
                }
                if max_rit < len && self.maxima[len - 1 - max_rit] <= self.edges[last_horz].top.0 {
                    max_rit = len;
                }
            }
        }
        let mut op1 = NIL;
        loop {
            let is_last_horz = horz == last_horz;
            let mut e = self.next_in_ael(horz, dir);
            while e != NIL {
                if len > 0 {
                    if dir == Direction::LeftToRight {
                        while max_it < len && self.maxima[max_it] < self.edges[e].curr.0 {
                            if self.edges[horz].out_idx >= 0 {
                                let pt = (self.maxima[max_it], self.edges[horz].bot.1);
                                self.add_out_pt(horz, pt);
                            }
                            max_it += 1;
                        }
                    } else {
                        while max_rit < len && self.maxima[len - 1 - max_rit] > self.edges[e].curr.0 {
                            if self.edges[horz].out_idx >= 0 {
                                let pt = (self.maxima[len - 1 - max_rit], self.edges[horz].bot.1);
                                self.add_out_pt(horz, pt);
                            }
                            max_rit += 1;
                        }
                    }
                }
                if (dir == Direction::LeftToRight && self.edges[e].curr.0 > horz_right)
                    || (dir == Direction::RightToLeft && self.edges[e].curr.0 < horz_left)
                {
                    break;
                }
                let next_lml = self.edges[horz].next_in_lml;
                if self.edges[e].curr.0 == self.edges[horz].top.0 && next_lml != NIL && self.edges[e].dx < self.edges[next_lml].dx {
                    break;
                }
                if self.edges[horz].out_idx >= 0 {
                    op1 = self.add_out_pt(horz, self.edges[e].curr);
                    self.add_horizontal_joins(horz, op1);
                    let off = self.edges[horz].bot;
                    self.ghost_joins.push(Join { op1, op2: NIL, off });
                }
                if e == max_pair && is_last_horz {
                    if self.edges[horz].out_idx >= 0 {
                        let top = self.edges[horz].top;
                        self.add_local_max_poly(horz, max_pair, top);
                    }
                    self.delete_from_ael(horz);
                    self.delete_from_ael(max_pair);
                    return Ok(());
                }
                let pt = (self.edges[e].curr.0, self.edges[horz].curr.1);
                if dir == Direction::LeftToRight {
                    self.intersect_edges(horz, e, pt);
                } else {
                    self.intersect_edges(e, horz, pt);
                }
                let next = self.next_in_ael(e, dir);
                self.swap_positions_in_ael(horz, e);
                e = next;
            }
            let next_lml = self.edges[horz].next_in_lml;
            if next_lml == NIL || !self.is_horizontal(next_lml) {
                break;
            }
            horz = self.update_edge_into_ael(horz)?;
            if self.edges[horz].out_idx >= 0 {
                self.add_out_pt(horz, self.edges[horz].bot);
            }
            (dir, horz_left, horz_right) = self.horz_direction(horz);
        }
        if self.edges[horz].out_idx >= 0 && op1 == NIL {
            op1 = self.get_last_out_pt(horz);
            self.add_horizontal_joins(horz, op1);
            let off = self.edges[horz].top;
            self.ghost_joins.push(Join { op1, op2: NIL, off });
        }
        if self.edges[horz].next_in_lml != NIL {
            if self.edges[horz].out_idx >= 0 {
                let op1 = self.add_out_pt(horz, self.edges[horz].top);
                horz = self.update_edge_into_ael(horz)?;
                if self.edges[horz].wind_delta == 0 {
                    return Ok(());
                }
                let prev = self.edges[horz].prev_in_ael;
                let next = self.edges[horz].next_in_ael;
                let bot = self.edges[horz].bot;
                let joins_with = |c: &Clipper, n: usize| {
                    n != NIL && c.edges[n].curr.0 == bot.0 && c.edges[n].curr.1 == bot.1 && c.edges[n].wind_delta != 0
                        && c.edges[n].out_idx >= 0 && c.edges[n].curr.1 > c.edges[n].top.1
                        && slopes_equal4(c.edges[horz].top, c.edges[horz].bot, c.edges[n].top, c.edges[n].bot)
                };
                if joins_with(self, prev) {
                    let op2 = self.add_out_pt(prev, bot);
                    let off = self.edges[horz].top;
                    self.joins.push(Join { op1, op2, off });
                } else if joins_with(self, next) {
                    let op2 = self.add_out_pt(next, bot);
                    let off = self.edges[horz].top;
                    self.joins.push(Join { op1, op2, off });
                }
            } else {
                self.update_edge_into_ael(horz)?;
            }
        } else {
            if self.edges[horz].out_idx >= 0 {
                self.add_out_pt(horz, self.edges[horz].top);
            }
            self.delete_from_ael(horz);
        }
        Ok(())
    }

    fn process_intersections(&mut self, top_y: i64) -> Result<bool, Failed> {
        if self.active == NIL {
            return Ok(true);
        }
        self.build_intersect_list(top_y);
        let size = self.intersections.len();
        if size == 0 {
            return Ok(true);
        }
        if size == 1 || self.fixup_intersection_order() {
            self.process_intersect_list();
        } else {
            return Ok(false);
        }
        self.sorted = NIL;
        Ok(true)
    }

    fn build_intersect_list(&mut self, top_y: i64) {
        let mut e = self.active;
        self.sorted = e;
        while e != NIL {
            self.edges[e].prev_in_sel = self.edges[e].prev_in_ael;
            self.edges[e].next_in_sel = self.edges[e].next_in_ael;
            self.edges[e].curr.0 = self.top_x(e, top_y);
            e = self.edges[e].next_in_ael;
        }
        loop {
            let mut modified = false;
            e = self.sorted;
            while self.edges[e].next_in_sel != NIL {
                let next = self.edges[e].next_in_sel;
                if self.edges[e].curr.0 > self.edges[next].curr.0 {
                    let mut pt = self.intersect_point(e, next);
                    if pt.1 < top_y {
                        pt = (self.top_x(e, top_y), top_y);
                    }
                    self.intersections.push(IntersectNode { edge1: e, edge2: next, pt });
                    self.swap_positions_in_sel(e, next);
                    modified = true;
                } else {
                    e = next;
                }
            }
            let prev = self.edges[e].prev_in_sel;
            if prev != NIL {
                self.edges[prev].next_in_sel = NIL;
            } else {
                break;
            }
            if !modified {
                break;
            }
        }
        self.sorted = NIL;
    }

    fn process_intersect_list(&mut self) {
        let list = std::mem::take(&mut self.intersections);
        for node in list {
            self.intersect_edges(node.edge1, node.edge2, node.pt);
            self.swap_positions_in_ael(node.edge1, node.edge2);
        }
    }

    fn edges_adjacent(&self, node: &IntersectNode) -> bool {
        self.edges[node.edge1].next_in_sel == node.edge2 || self.edges[node.edge1].prev_in_sel == node.edge2
    }

    fn fixup_intersection_order(&mut self) -> bool {
        self.copy_ael_to_sel();
        gnu_sort(&mut self.intersections, &|a: &IntersectNode, b: &IntersectNode| b.pt.1 < a.pt.1);
        let count = self.intersections.len();
        for i in 0..count {
            if !self.edges_adjacent(&self.intersections[i]) {
                let mut j = i + 1;
                while j < count && !self.edges_adjacent(&self.intersections[j]) {
                    j += 1;
                }
                if j == count {
                    return false;
                }
                self.intersections.swap(i, j);
            }
            let node = self.intersections[i];
            self.swap_positions_in_sel(node.edge1, node.edge2);
        }
        true
    }

    fn do_maxima(&mut self, e: usize) -> Result<(), Failed> {
        let max_pair = self.get_maxima_pair_ex(e);
        if max_pair == NIL {
            if self.edges[e].out_idx >= 0 {
                self.add_out_pt(e, self.edges[e].top);
            }
            self.delete_from_ael(e);
            return Ok(());
        }
        let mut next = self.edges[e].next_in_ael;
        while next != NIL && next != max_pair {
            let top = self.edges[e].top;
            self.intersect_edges(e, next, top);
            self.swap_positions_in_ael(e, next);
            next = self.edges[e].next_in_ael;
        }
        if self.edges[e].out_idx == UNASSIGNED && self.edges[max_pair].out_idx == UNASSIGNED {
            self.delete_from_ael(e);
            self.delete_from_ael(max_pair);
        } else if self.edges[e].out_idx >= 0 && self.edges[max_pair].out_idx >= 0 {
            let top = self.edges[e].top;
            self.add_local_max_poly(e, max_pair, top);
            self.delete_from_ael(e);
            self.delete_from_ael(max_pair);
        } else {
            return Err(Failed);
        }
        Ok(())
    }

    fn is_maxima(&self, e: usize, y: i64) -> bool {
        e != NIL && self.edges[e].top.1 == y && self.edges[e].next_in_lml == NIL
    }

    fn is_intermediate(&self, e: usize, y: i64) -> bool {
        self.edges[e].top.1 == y && self.edges[e].next_in_lml != NIL
    }

    fn process_edges_at_top_of_scanbeam(&mut self, top_y: i64) -> Result<(), Failed> {
        let mut e = self.active;
        while e != NIL {
            let mut is_maxima_edge = self.is_maxima(e, top_y);
            if is_maxima_edge {
                let max_pair = self.get_maxima_pair_ex(e);
                is_maxima_edge = max_pair == NIL || !self.is_horizontal(max_pair);
            }
            if is_maxima_edge {
                self.maxima.push(self.edges[e].top.0);
                let prev = self.edges[e].prev_in_ael;
                self.do_maxima(e)?;
                e = if prev == NIL { self.active } else { self.edges[prev].next_in_ael };
            } else {
                if self.is_intermediate(e, top_y) && self.is_horizontal(self.edges[e].next_in_lml) {
                    e = self.update_edge_into_ael(e)?;
                    if self.edges[e].out_idx >= 0 {
                        self.add_out_pt(e, self.edges[e].bot);
                    }
                    self.add_edge_to_sel(e);
                } else {
                    self.edges[e].curr = (self.top_x(e, top_y), top_y);
                }
                // Strictly simple: give touching edges a vertex each (type-3 join).
                let prev = self.edges[e].prev_in_ael;
                if self.edges[e].out_idx >= 0 && self.edges[e].wind_delta != 0 && prev != NIL && self.edges[prev].out_idx >= 0
                    && self.edges[prev].curr.0 == self.edges[e].curr.0 && self.edges[prev].wind_delta != 0
                {
                    let pt = self.edges[e].curr;
                    let op = self.add_out_pt(prev, pt);
                    let op2 = self.add_out_pt(e, pt);
                    self.joins.push(Join { op1: op, op2, off: pt });
                }
                e = self.edges[e].next_in_ael;
            }
        }
        self.maxima.sort_unstable();
        self.process_horizontals()?;
        self.maxima.clear();
        e = self.active;
        while e != NIL {
            if self.is_intermediate(e, top_y) {
                let op = if self.edges[e].out_idx >= 0 { self.add_out_pt(e, self.edges[e].top) } else { NIL };
                e = self.update_edge_into_ael(e)?;
                let prev = self.edges[e].prev_in_ael;
                let next = self.edges[e].next_in_ael;
                let (bot, curr, top) = (self.edges[e].bot, self.edges[e].curr, self.edges[e].top);
                let joins_with = |c: &Clipper, n: usize| {
                    n != NIL && c.edges[n].curr.0 == bot.0 && c.edges[n].curr.1 == bot.1 && op != NIL && c.edges[n].out_idx >= 0
                        && c.edges[n].curr.1 > c.edges[n].top.1
                        && slopes_equal4(curr, top, c.edges[n].curr, c.edges[n].top)
                        && c.edges[e].wind_delta != 0 && c.edges[n].wind_delta != 0
                };
                if joins_with(self, prev) {
                    let op2 = self.add_out_pt(prev, bot);
                    self.joins.push(Join { op1: op, op2, off: top });
                } else if joins_with(self, next) {
                    let op2 = self.add_out_pt(next, bot);
                    self.joins.push(Join { op1: op, op2, off: top });
                }
            }
            e = self.edges[e].next_in_ael;
        }
        Ok(())
    }

    fn fixup_out_polygon(&mut self, rec: usize) {
        let mut last_ok = NIL;
        self.poly_outs[rec].bottom_pt = NIL;
        let mut pp = self.poly_outs[rec].pts;
        loop {
            let (prev, next) = (self.out_pts[pp].prev, self.out_pts[pp].next);
            if prev == pp || prev == next {
                self.poly_outs[rec].pts = NIL;
                return;
            }
            let (a, b, c) = (self.out_pts[prev].pt, self.out_pts[pp].pt, self.out_pts[next].pt);
            if b == c || b == a || (slopes_equal3(a, b, c) && !pt2_is_between_pt1_and_pt3(a, b, c)) {
                last_ok = NIL;
                self.out_pts[prev].next = next;
                self.out_pts[next].prev = prev;
                pp = prev;
            } else if pp == last_ok {
                break;
            } else {
                if last_ok == NIL {
                    last_ok = pp;
                }
                pp = next;
            }
        }
        self.poly_outs[rec].pts = pp;
    }

    fn area(&self, op: usize) -> f64 {
        let start = op;
        let mut op = op;
        let mut a = 0.0;
        loop {
            let prev = self.out_pts[self.out_pts[op].prev].pt;
            let pt = self.out_pts[op].pt;
            a += (prev.0 + pt.0) as f64 * (prev.1 - pt.1) as f64;
            op = self.out_pts[op].next;
            if op == start {
                break;
            }
        }
        a * 0.5
    }

    fn reverse_poly_pt_links(&mut self, pp: usize) {
        reverse_links(&mut self.out_pts, pp);
    }

    fn dup_out_pt(&mut self, op: usize, insert_after: bool) -> usize {
        let (pt, idx) = (self.out_pts[op].pt, self.out_pts[op].idx);
        let result = self.new_out_pt(idx, pt);
        if insert_after {
            let next = self.out_pts[op].next;
            self.out_pts[result].next = next;
            self.out_pts[result].prev = op;
            self.out_pts[next].prev = result;
            self.out_pts[op].next = result;
        } else {
            let prev = self.out_pts[op].prev;
            self.out_pts[result].prev = prev;
            self.out_pts[result].next = op;
            self.out_pts[prev].next = result;
            self.out_pts[op].prev = result;
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn join_horz(&mut self, mut op1: usize, mut op1b: usize, mut op2: usize, mut op2b: usize, pt: Point, discard_left: bool) -> bool {
        let dir = |c: &Clipper, a: usize, b: usize| if c.out_pts[a].pt.0 > c.out_pts[b].pt.0 { Direction::RightToLeft } else { Direction::LeftToRight };
        let dir1 = dir(self, op1, op1b);
        let dir2 = dir(self, op2, op2b);
        if dir1 == dir2 {
            return false;
        }
        for (op, opb, d) in [(&mut op1, &mut op1b, dir1), (&mut op2, &mut op2b, dir2)] {
            if d == Direction::LeftToRight {
                loop {
                    let n = self.out_pts[*op].next;
                    let (np, p) = (self.out_pts[n].pt, self.out_pts[*op].pt);
                    if np.0 <= pt.0 && np.0 >= p.0 && np.1 == pt.1 {
                        *op = n;
                    } else {
                        break;
                    }
                }
                if discard_left && self.out_pts[*op].pt.0 != pt.0 {
                    *op = self.out_pts[*op].next;
                }
                *opb = self.dup_out_pt(*op, !discard_left);
                if self.out_pts[*opb].pt != pt {
                    *op = *opb;
                    self.out_pts[*op].pt = pt;
                    *opb = self.dup_out_pt(*op, !discard_left);
                }
            } else {
                loop {
                    let n = self.out_pts[*op].next;
                    let (np, p) = (self.out_pts[n].pt, self.out_pts[*op].pt);
                    if np.0 >= pt.0 && np.0 <= p.0 && np.1 == pt.1 {
                        *op = n;
                    } else {
                        break;
                    }
                }
                if !discard_left && self.out_pts[*op].pt.0 != pt.0 {
                    *op = self.out_pts[*op].next;
                }
                *opb = self.dup_out_pt(*op, discard_left);
                if self.out_pts[*opb].pt != pt {
                    *op = *opb;
                    self.out_pts[*op].pt = pt;
                    *opb = self.dup_out_pt(*op, discard_left);
                }
            }
        }
        let o = &mut self.out_pts;
        if (dir1 == Direction::LeftToRight) == discard_left {
            o[op1].prev = op2;
            o[op2].next = op1;
            o[op1b].next = op2b;
            o[op2b].prev = op1b;
        } else {
            o[op1].next = op2;
            o[op2].prev = op1;
            o[op1b].prev = op2b;
            o[op2b].next = op1b;
        }
        true
    }

    fn link_join(&mut self, j: &mut Join, reverse1: bool) {
        let (op1, op2) = (j.op1, j.op2);
        if reverse1 {
            let op1b = self.dup_out_pt(op1, false);
            let op2b = self.dup_out_pt(op2, true);
            self.out_pts[op1].prev = op2;
            self.out_pts[op2].next = op1;
            self.out_pts[op1b].next = op2b;
            self.out_pts[op2b].prev = op1b;
            j.op2 = op1b;
        } else {
            let op1b = self.dup_out_pt(op1, true);
            let op2b = self.dup_out_pt(op2, false);
            self.out_pts[op1].next = op2;
            self.out_pts[op2].prev = op1;
            self.out_pts[op1b].prev = op2b;
            self.out_pts[op2b].next = op1b;
            j.op2 = op1b;
        }
    }

    fn join_points(&mut self, j: &mut Join, r1: usize, r2: usize) -> bool {
        let (mut op1, mut op2) = (j.op1, j.op2);
        let is_horizontal = self.out_pts[j.op1].pt.1 == j.off.1;
        if is_horizontal && j.off == self.out_pts[j.op1].pt && j.off == self.out_pts[j.op2].pt {
            if r1 != r2 {
                return false;
            }
            let mut op1b = self.out_pts[j.op1].next;
            while op1b != op1 && self.out_pts[op1b].pt == j.off {
                op1b = self.out_pts[op1b].next;
            }
            let reverse1 = self.out_pts[op1b].pt.1 > j.off.1;
            let mut op2b = self.out_pts[j.op2].next;
            while op2b != op2 && self.out_pts[op2b].pt == j.off {
                op2b = self.out_pts[op2b].next;
            }
            let reverse2 = self.out_pts[op2b].pt.1 > j.off.1;
            if reverse1 == reverse2 {
                return false;
            }
            self.link_join(j, reverse1);
            true
        } else if is_horizontal {
            let o = &self.out_pts;
            let mut op1b = op1;
            while o[o[op1].prev].pt.1 == o[op1].pt.1 && o[op1].prev != op1b && o[op1].prev != op2 {
                op1 = o[op1].prev;
            }
            while o[o[op1b].next].pt.1 == o[op1b].pt.1 && o[op1b].next != op1 && o[op1b].next != op2 {
                op1b = o[op1b].next;
            }
            if o[op1b].next == op1 || o[op1b].next == op2 {
                return false;
            }
            let mut op2b = op2;
            while o[o[op2].prev].pt.1 == o[op2].pt.1 && o[op2].prev != op2b && o[op2].prev != op1b {
                op2 = o[op2].prev;
            }
            while o[o[op2b].next].pt.1 == o[op2b].pt.1 && o[op2b].next != op2 && o[op2b].next != op1 {
                op2b = o[op2b].next;
            }
            if o[op2b].next == op2 || o[op2b].next == op1 {
                return false;
            }
            let Some((left, right)) = get_overlap(o[op1].pt.0, o[op1b].pt.0, o[op2].pt.0, o[op2b].pt.0) else { return false };
            let (pt, discard_left) = if o[op1].pt.0 >= left && o[op1].pt.0 <= right {
                (o[op1].pt, o[op1].pt.0 > o[op1b].pt.0)
            } else if o[op2].pt.0 >= left && o[op2].pt.0 <= right {
                (o[op2].pt, o[op2].pt.0 > o[op2b].pt.0)
            } else if o[op1b].pt.0 >= left && o[op1b].pt.0 <= right {
                (o[op1b].pt, o[op1b].pt.0 > o[op1].pt.0)
            } else {
                (o[op2b].pt, o[op2b].pt.0 > o[op2].pt.0)
            };
            j.op1 = op1;
            j.op2 = op2;
            self.join_horz(op1, op1b, op2, op2b, pt, discard_left)
        } else {
            let o = &self.out_pts;
            let mut op1b = o[op1].next;
            while o[op1b].pt == o[op1].pt && op1b != op1 {
                op1b = o[op1b].next;
            }
            let reverse1 = o[op1b].pt.1 > o[op1].pt.1 || !slopes_equal3(o[op1].pt, o[op1b].pt, j.off);
            if reverse1 {
                op1b = o[op1].prev;
                while o[op1b].pt == o[op1].pt && op1b != op1 {
                    op1b = o[op1b].prev;
                }
                if o[op1b].pt.1 > o[op1].pt.1 || !slopes_equal3(o[op1].pt, o[op1b].pt, j.off) {
                    return false;
                }
            }
            let mut op2b = o[op2].next;
            while o[op2b].pt == o[op2].pt && op2b != op2 {
                op2b = o[op2b].next;
            }
            let reverse2 = o[op2b].pt.1 > o[op2].pt.1 || !slopes_equal3(o[op2].pt, o[op2b].pt, j.off);
            if reverse2 {
                op2b = o[op2].prev;
                while o[op2b].pt == o[op2].pt && op2b != op2 {
                    op2b = o[op2b].prev;
                }
                if o[op2b].pt.1 > o[op2].pt.1 || !slopes_equal3(o[op2].pt, o[op2b].pt, j.off) {
                    return false;
                }
            }
            if op1b == op1 || op2b == op2 || op1b == op2b || (r1 == r2 && reverse1 == reverse2) {
                return false;
            }
            self.link_join(j, reverse1);
            true
        }
    }

    fn update_out_pt_idxs(&mut self, rec: usize) {
        let start = self.poly_outs[rec].pts;
        let idx = self.poly_outs[rec].idx;
        let mut op = start;
        loop {
            self.out_pts[op].idx = idx;
            op = self.out_pts[op].prev;
            if op == start {
                break;
            }
        }
    }

    fn point_in_polygon(&self, pt: Point, op: usize) -> i32 {
        let o = &self.out_pts;
        let mut result = 0;
        let start = op;
        let mut op = op;
        loop {
            let (p, n) = (o[op].pt, o[o[op].next].pt);
            if n.1 == pt.1 && (n.0 == pt.0 || (p.1 == pt.1 && ((n.0 > pt.0) == (p.0 < pt.0)))) {
                return -1;
            }
            if (p.1 < pt.1) != (n.1 < pt.1) {
                if p.0 >= pt.0 {
                    if n.0 > pt.0 {
                        result = 1 - result;
                    } else {
                        let d = (p.0 - pt.0) as f64 * (n.1 - pt.1) as f64 - (n.0 - pt.0) as f64 * (p.1 - pt.1) as f64;
                        if d == 0.0 {
                            return -1;
                        }
                        if (d > 0.0) == (n.1 > p.1) {
                            result = 1 - result;
                        }
                    }
                } else if n.0 > pt.0 {
                    let d = (p.0 - pt.0) as f64 * (n.1 - pt.1) as f64 - (n.0 - pt.0) as f64 * (p.1 - pt.1) as f64;
                    if d == 0.0 {
                        return -1;
                    }
                    if (d > 0.0) == (n.1 > p.1) {
                        result = 1 - result;
                    }
                }
            }
            op = o[op].next;
            if op == start {
                break;
            }
        }
        result
    }

    fn poly2_contains_poly1(&self, op1: usize, op2: usize) -> bool {
        let mut op = op1;
        loop {
            let res = self.point_in_polygon(self.out_pts[op].pt, op2);
            if res >= 0 {
                return res > 0;
            }
            op = self.out_pts[op].next;
            if op == op1 {
                return true;
            }
        }
    }

    /// The hole states after splitting `r1` into `r1` and the new `r2`
    /// (shared by `JoinCommonEdges` and `DoSimplePolygons`).
    fn classify_split(&mut self, r1: usize, r2: usize, reorient: bool) {
        if self.poly2_contains_poly1(self.poly_outs[r2].pts, self.poly_outs[r1].pts) {
            self.poly_outs[r2].is_hole = !self.poly_outs[r1].is_hole;
            self.poly_outs[r2].first_left = r1;
            if reorient && self.poly_outs[r2].is_hole == (self.area(self.poly_outs[r2].pts) > 0.0) {
                self.reverse_poly_pt_links(self.poly_outs[r2].pts);
            }
        } else if self.poly2_contains_poly1(self.poly_outs[r1].pts, self.poly_outs[r2].pts) {
            self.poly_outs[r2].is_hole = self.poly_outs[r1].is_hole;
            self.poly_outs[r1].is_hole = !self.poly_outs[r2].is_hole;
            self.poly_outs[r2].first_left = self.poly_outs[r1].first_left;
            self.poly_outs[r1].first_left = r2;
            if reorient && self.poly_outs[r1].is_hole == (self.area(self.poly_outs[r1].pts) > 0.0) {
                self.reverse_poly_pt_links(self.poly_outs[r1].pts);
            }
        } else {
            self.poly_outs[r2].is_hole = self.poly_outs[r1].is_hole;
            self.poly_outs[r2].first_left = self.poly_outs[r1].first_left;
        }
    }

    fn join_common_edges(&mut self) {
        for i in 0..self.joins.len() {
            let mut join = self.joins[i];
            let r1 = self.get_out_rec(self.out_pts[join.op1].idx);
            let mut r2 = self.get_out_rec(self.out_pts[join.op2].idx);
            if self.poly_outs[r1].pts == NIL || self.poly_outs[r2].pts == NIL {
                continue;
            }
            let hole_state_rec = if r1 == r2 {
                r1
            } else if self.rec1_right_of_rec2(r1, r2) {
                r2
            } else if self.rec1_right_of_rec2(r2, r1) {
                r1
            } else {
                self.get_lowermost_rec(r1, r2)
            };
            if !self.join_points(&mut join, r1, r2) {
                continue;
            }
            self.joins[i] = join;
            if r1 == r2 {
                self.poly_outs[r1].pts = join.op1;
                self.poly_outs[r1].bottom_pt = NIL;
                r2 = self.create_out_rec();
                self.poly_outs[r2].pts = join.op2;
                self.update_out_pt_idxs(r2);
                self.classify_split(r1, r2, true);
            } else {
                self.poly_outs[r2].pts = NIL;
                self.poly_outs[r2].bottom_pt = NIL;
                self.poly_outs[r2].idx = self.poly_outs[r1].idx;
                self.poly_outs[r1].is_hole = self.poly_outs[hole_state_rec].is_hole;
                if hole_state_rec == r2 {
                    self.poly_outs[r1].first_left = self.poly_outs[r2].first_left;
                }
                self.poly_outs[r2].first_left = r1;
            }
        }
    }

    fn do_simple_polygons(&mut self) {
        let mut i = 0;
        while i < self.poly_outs.len() {
            let rec = i;
            i += 1;
            let mut op = self.poly_outs[rec].pts;
            if op == NIL {
                continue;
            }
            loop {
                let mut op2 = self.out_pts[op].next;
                while op2 != self.poly_outs[rec].pts {
                    if self.out_pts[op].pt == self.out_pts[op2].pt && self.out_pts[op2].next != op && self.out_pts[op2].prev != op {
                        let op3 = self.out_pts[op].prev;
                        let op4 = self.out_pts[op2].prev;
                        self.out_pts[op].prev = op4;
                        self.out_pts[op4].next = op;
                        self.out_pts[op2].prev = op3;
                        self.out_pts[op3].next = op2;
                        self.poly_outs[rec].pts = op;
                        let rec2 = self.create_out_rec();
                        self.poly_outs[rec2].pts = op2;
                        self.update_out_pt_idxs(rec2);
                        self.classify_split(rec, rec2, false);
                        op2 = op;
                    }
                    op2 = self.out_pts[op2].next;
                }
                op = self.out_pts[op].next;
                if op == self.poly_outs[rec].pts {
                    break;
                }
            }
        }
    }

    fn build_result(&self) -> Vec<Vec<Point>> {
        let mut polys = Vec::new();
        for rec in &self.poly_outs {
            if rec.pts == NIL {
                continue;
            }
            let mut p = self.out_pts[rec.pts].prev;
            let mut count = 0;
            let start = p;
            loop {
                count += 1;
                p = self.out_pts[p].next;
                if p == start {
                    break;
                }
            }
            if count < 2 {
                continue;
            }
            let mut path = Vec::with_capacity(count);
            for _ in 0..count {
                path.push(self.out_pts[p].pt);
                p = self.out_pts[p].prev;
            }
            polys.push(path);
        }
        polys
    }
}

fn reverse_links(o: &mut [OutPt], pp: usize) {
    let mut p1 = pp;
    loop {
        let p2 = o[p1].next;
        o[p1].next = o[p1].prev;
        o[p1].prev = p2;
        p1 = p2;
        if p1 == pp {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_ORDER_HASH: u64 = 0x6176_e8b8_846c_b205;

    /// `validation/matlab/gnu-sort-probe.cpp` built with GCC 15.2 (libstdc++)
    /// leaves these orders, FNV-1a hashed over the ids: equal keys must keep
    /// libstdc++'s introsort order, not a stable or other sort's.
    #[test]
    fn gnu_sort_reproduces_libstdcxx_tie_order() {
        let mut state = 88172645463325252u64;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut hash = 0xcbf29ce484222325u64;
        for n in [2usize, 5, 16, 17, 18, 31, 64, 100, 257, 1000] {
            for keys in [1u64, 2, 3, 7, 50] {
                let mut v: Vec<(i64, usize)> = (0..n).map(|i| ((next() % keys) as i64, i)).collect();
                gnu_sort(&mut v, &|a: &(i64, usize), b: &(i64, usize)| b.0 < a.0);
                assert!(v.windows(2).all(|w| w[0].0 >= w[1].0));
                for (_, id) in v {
                    for byte in (id as u32).to_le_bytes() {
                        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
                    }
                }
            }
        }
        assert_eq!(hash, EXPECTED_ORDER_HASH);
    }

    #[test]
    fn a_square_is_its_own_union() {
        let out = simplify_even_odd(&[vec![(0, 0), (10, 0), (10, 10), (0, 10)]]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 4);
    }

    #[test]
    fn a_bowtie_splits_into_two_triangles() {
        let out = simplify_even_odd(&[vec![(0, 0), (10, 10), (10, 0), (0, 10)]]).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|p| p.len() == 3 && p.contains(&(5, 5))));
    }
}
