use std::io;
use std::process::ExitCode;

use weavit_projector::protocol::{Message, PROTOCOL, write_message};
use weavit_projector::{RunError, run};

fn main() -> ExitCode {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = write_message(&mut out, &Message::Hello { protocol: PROTOCOL }) {
        return exit_code(&RunError::Io(e));
    }
    match run(io::stdin().lock(), &mut out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let code = exit_code(&e);
            if code != ExitCode::from(3) {
                let msg = Message::Error {
                    message: e.to_string(),
                };
                if let Err(werr) = write_message(&mut out, &msg) {
                    return exit_code(&RunError::Io(werr));
                }
            }
            code
        }
    }
}

fn exit_code(e: &RunError) -> ExitCode {
    ExitCode::from(u8::try_from(e.exit_code()).unwrap_or(1))
}
