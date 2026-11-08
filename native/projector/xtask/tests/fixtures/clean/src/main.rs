fn main() {
    // A thin shell. `clap` lives here and in cli.rs — never in domain/.
    println!("{}", clean_fixture::domain::greeting("world"));
}
